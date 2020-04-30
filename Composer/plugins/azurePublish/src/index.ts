// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'path';

import { BotProjectDeploy } from '@bfc/libs/bot-deploy';
import { v4 as uuid, v5 as hash } from 'uuid';
import { copy, rmdir, emptyDir, readJson, pathExists, writeJson, mkdirSync, writeFileSync } from 'fs-extra';

import schema from './schema';

// This option controls whether the history is serialized to a file between sessions with Composer
// set to TRUE for history to be saved to disk
// set to FALSE for history to be cached in memory only
const PERSIST_HISTORY = false;

interface CreateAndDeployResources {
  publishName: string;
  environment: string;
  subscriptionID: string;
  luisAuthoringKey?: string;
  luisAuthoringRegion?: string;
}

interface PublishConfig {
  settings: any;
  templatePath: string;
  name: string; //profile name
  [key: string]: any;
}

class AzurePublisher {
  private publishingBots: { [key: string]: any };
  private historyFilePath: string;
  private histories: any;
  private azDeployer: BotProjectDeploy;
  private logMessages: any[];
  constructor() {
    this.histories = {};
    this.historyFilePath = path.resolve(__dirname, '../publishHistory.txt');
    if (PERSIST_HISTORY) {
      this.loadHistoryFromFile();
    }
    this.publishingBots = {};
    this.logMessages = [];
  }
  private getProjectFolder = (key: string) => path.resolve(__dirname, `../publishBots/${key}`);
  private getBotFolder = (key: string) => path.resolve(this.getProjectFolder(key), 'ComposerDialogs');
  private getSettingsPath = (key: string) => path.resolve(this.getBotFolder(key), 'settings/appsettings.json');

  private init = async (botFiles: any, settings: any, srcTemplate: string, resourcekey: string) => {
    const projExist = await pathExists(this.getProjectFolder(resourcekey));
    const botExist = await pathExists(this.getBotFolder(resourcekey));
    const botFolder = this.getBotFolder(resourcekey);
    const projFolder = this.getProjectFolder(resourcekey);
    const settingsPath = this.getSettingsPath(resourcekey);
    // deploy resource exist
    await emptyDir(projFolder);
    if (!projExist) {
      mkdirSync(projFolder, { recursive: true });
    }
    if (!botExist) {
      mkdirSync(botFolder, { recursive: true });
    }
    // save bot files
    for (const file of botFiles) {
      const filePath = path.resolve(botFolder, file.relativePath);
      if (!(await pathExists(path.dirname(filePath)))) {
        mkdirSync(path.dirname(filePath), { recursive: true });
      }
      writeFileSync(filePath, file.content);
    }

    // save the settings file
    if (!(await pathExists(path.dirname(settingsPath)))) {
      mkdirSync(path.dirname(settingsPath), { recursive: true });
    }
    await writeJson(settingsPath, settings, { spaces: 4 });
    // copy bot and runtime into projFolder
    await copy(srcTemplate, projFolder);
  };

  private async cleanup(resourcekey: string) {
    const projFolder = this.getProjectFolder(resourcekey);
    await emptyDir(projFolder);
    await rmdir(projFolder);
  }

  private async loadHistoryFromFile() {
    if (await pathExists(this.historyFilePath)) {
      this.histories = await readJson(this.historyFilePath);
    }
  }

  private getHistory = async (botId: string, profileName: string) => {
    if (this.histories && this.histories[botId] && this.histories[botId][profileName]) {
      return this.histories[botId][profileName];
    }
    return [];
  };

  private updateHistory = async (botId: string, profileName: string, newHistory: any) => {
    if (!this.histories[botId]) {
      this.histories[botId] = {};
    }
    if (!this.histories[botId][profileName]) {
      this.histories[botId][profileName] = [];
    }
    this.histories[botId][profileName].unshift(newHistory);
    if (PERSIST_HISTORY) {
      await writeJson(this.historyFilePath, this.histories);
    }
  };

  private addLoadingStatus = (botId: string, profileName: string, newStatus) => {
    // save in publishingBots
    if (!this.publishingBots[botId]) {
      this.publishingBots[botId] = {};
    }
    if (!this.publishingBots[botId][profileName]) {
      this.publishingBots[botId][profileName] = [];
    }
    this.publishingBots[botId][profileName].push(newStatus);
  };
  private removeLoadingStatus = (botId: string, profileName: string, jobId: string) => {
    if (this.publishingBots[botId] && this.publishingBots[botId][profileName]) {
      const index = this.publishingBots[botId][profileName].findIndex(item => item.result.id === jobId);
      const status = this.publishingBots[botId][profileName][index];
      this.publishingBots[botId][profileName] = this.publishingBots[botId][profileName]
        .slice(0, index)
        .concat(this.publishingBots[botId][profileName].slice(index + 1));
      return status;
    }
    return;
  };
  private getLoadingStatus = (botId: string, profileName: string, jobId = '') => {
    if (this.publishingBots[botId] && this.publishingBots[botId][profileName].length > 0) {
      // get current status
      if (jobId) {
        return this.publishingBots[botId][profileName].find(item => item.result.id === jobId);
      }
      return this.publishingBots[botId][profileName][this.publishingBots[botId][profileName].length - 1];
    }
    return undefined;
  };

  private createAndDeploy = async (
    botId: string,
    profileName: string,
    jobId: string,
    resourcekey: string,
    customizeConfiguration: CreateAndDeployResources
  ) => {
    const { publishName, environment, luisAuthoringKey, luisAuthoringRegion } = customizeConfiguration;
    try {
      // Perform the deploy
      await this.azDeployer.deploy(publishName, environment, luisAuthoringKey, luisAuthoringRegion);

      // update status and history
      const status = this.getLoadingStatus(botId, profileName, jobId);

      if (status) {
        status.status = 200;
        status.result.message = 'Success';
        status.result.log = this.logMessages.join('\n');
        await this.updateHistory(botId, profileName, { status: status.status, ...status.result });
        this.removeLoadingStatus(botId, profileName, jobId);
        await this.cleanup(resourcekey);
      }
    } catch (error) {
      console.log(error);
      // update status and history
      const status = this.getLoadingStatus(botId, profileName, jobId);
      if (status) {
        status.status = 500;
        status.result.message = error ? error.message : 'publish error';
        status.result.log = this.logMessages.join('\n');
        await this.updateHistory(botId, profileName, { status: status.status, ...status.result });
        this.removeLoadingStatus(botId, profileName, jobId);
        await this.cleanup(resourcekey);
      }
    }
  };

  /**************************************************************************************************
   * plugin methods
   *************************************************************************************************/
  publish = async (config: PublishConfig, project, metadata, user) => {
    // templatePath point to the CSharp code
    const {
      settings,
      templatePath,
      name,
      subscriptionID,
      publishName,
      environment,
      location,
      luisAuthoringKey,
      luisAuthoringRegion,
      provision,
      accessToken,
    } = config;

    // point to the declarative assets (possibly in remote storage)
    const botFiles = project.files;

    // get the bot id from the project
    const botId = project.id;

    // generate an id to track this deploy
    const jobId = uuid();

    // resource key to map to one provision resource
    const resourcekey = hash(
      [
        project.name,
        subscriptionID,
        publishName,
        location,
        environment,
        provision?.MicrosoftAppPassword,
        luisAuthoringKey,
        luisAuthoringRegion,
      ],
      subscriptionID
    );

    // If the project is using an "ejected" runtime, use that version of the code instead of the built-in template
    let runtimeCodePath = templatePath;
    if (
      project.settings &&
      project.settings.runtime &&
      project.settings.runtime.customRuntime === true &&
      project.settings.runtime.path
    ) {
      runtimeCodePath = project.settings.runtime.path;
    }

    await this.init(botFiles, settings, runtimeCodePath, resourcekey);

    try {
      // test creds, if not valid, return 500
      if (!accessToken) {
        throw new Error('Required field `accessToken` is missing from publishing profile.');
      }
      if (!provision) {
        throw new Error(
          'no successful created resource in Azure according to your config, please run provision script to do the provision'
        );
      }

      const customizeConfiguration: CreateAndDeployResources = {
        subscriptionID,
        publishName,
        environment,
        luisAuthoringKey,
        luisAuthoringRegion,
      };

      // append provision resource into file
      const resourcePath = path.resolve(this.getProjectFolder(resourcekey), 'appsettings.deployment.json');
      const appSettings = await readJson(resourcePath);
      await writeJson(
        resourcePath,
        { ...appSettings, ...provision },
        {
          spaces: 4,
        }
      );

      this.azDeployer = new BotProjectDeploy({
        subId: subscriptionID,
        logger: (msg: any) => {
          console.log(msg);
          this.logMessages.push(JSON.stringify(msg, null, 2));
        },
        accessToken: accessToken,
        projPath: this.getProjectFolder(resourcekey),
      });

      this.logMessages = ['Publish starting...'];
      const response = {
        status: 202,
        result: {
          id: jobId,
          time: new Date(),
          message: 'Accepted for publishing.',
          log: this.logMessages.join('\n'),
          comment: metadata.comment,
        },
      };
      this.addLoadingStatus(botId, name, response);

      this.createAndDeploy(botId, name, jobId, resourcekey, customizeConfiguration);

      return response;
    } catch (err) {
      console.log(err);
      this.logMessages.push(err.message);
      const response = {
        status: 500,
        result: {
          id: jobId,
          time: new Date(),
          message: 'Publish Fail',
          log: this.logMessages.join('\n'),
          comment: metadata.comment,
        },
      };
      this.updateHistory(botId, name, { status: response.status, ...response.result });
      this.cleanup(resourcekey);
      return response;
    }
  };

  getStatus = async (config: PublishConfig, project, user) => {
    const profileName = config.name;
    const botId = project.id;
    // return latest status
    const status = this.getLoadingStatus(botId, profileName);
    if (status) {
      return status;
    } else {
      const current = await this.getHistory(botId, profileName);
      if (current.length > 0) {
        return { status: current[0].status, result: { ...current[0] } };
      }
      return {
        status: 404,
        result: {
          message: 'bot not published',
        },
      };
    }
  };

  history = async (config: PublishConfig, project, user) => {
    const profileName = config.name;
    const botId = project.id;
    return await this.getHistory(botId, profileName);
  };
}

const azurePublish = new AzurePublisher();

export default async (composer: any): Promise<void> => {
  await composer.addPublishMethod(azurePublish, schema);
};
