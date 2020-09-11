import * as fs from 'fs';
import * as path from 'path';

import * as analysisPaths from './analysis-paths';
import { getCodeQL } from './codeql';
import * as configUtils from './config-utils';
import { isScannedLanguage } from './languages';
import { Logger } from './logging';
import { RepositoryNwo } from './repository';
import * as sharedEnv from './shared-environment';
import * as upload_lib from './upload-lib';
import * as util from './util';

export interface QueriesStatusReport {
  // Time taken in ms to analyze builtin queries for cpp (or undefined if this language was not analyzed)
  analyze_builtin_queries_cpp_duration_ms?: number;
  // Time taken in ms to analyze builtin queries for csharp (or undefined if this language was not analyzed)
  analyze_builtin_queries_csharp_duration_ms?: number;
  // Time taken in ms to analyze builtin queries for go (or undefined if this language was not analyzed)
  analyze_builtin_queries_go_duration_ms?: number;
  // Time taken in ms to analyze builtin queries for java (or undefined if this language was not analyzed)
  analyze_builtin_queries_java_duration_ms?: number;
  // Time taken in ms to analyze builtin queries for javascript (or undefined if this language was not analyzed)
  analyze_builtin_queries_javascript_duration_ms?: number;
  // Time taken in ms to analyze builtin queries for python (or undefined if this language was not analyzed)
  analyze_builtin_queries_python_duration_ms?: number;
  // Time taken in ms to analyze custom queries for cpp (or undefined if this language was not analyzed)
  analyze_custom_queries_cpp_duration_ms?: number;
  // Time taken in ms to analyze custom queries for csharp (or undefined if this language was not analyzed)
  analyze_custom_queries_csharp_duration_ms?: number;
  // Time taken in ms to analyze custom queries for go (or undefined if this language was not analyzed)
  analyze_custom_queries_go_duration_ms?: number;
  // Time taken in ms to analyze custom queries for java (or undefined if this language was not analyzed)
  analyze_custom_queries_java_duration_ms?: number;
  // Time taken in ms to analyze custom queries for javascript (or undefined if this language was not analyzed)
  analyze_custom_queries_javascript_duration_ms?: number;
  // Time taken in ms to analyze custom queries for python (or undefined if this language was not analyzed)
  analyze_custom_queries_python_duration_ms?: number;
  // Name of language that errored during analysis (or undefined if no langauge failed)
  analyze_failure_language?: string;
}

export interface AnalysisStatusReport extends upload_lib.UploadStatusReport, QueriesStatusReport {}

async function createdDBForScannedLanguages(
  config: configUtils.Config,
  logger: Logger) {

  // Insert the LGTM_INDEX_X env vars at this point so they are set when
  // we extract any scanned languages.
  analysisPaths.includeAndExcludeAnalysisPaths(config);

  const codeql = getCodeQL(config.codeQLCmd);
  for (const language of config.languages) {
    if (isScannedLanguage(language)) {
      logger.startGroup('Extracting ' + language);
      await codeql.extractScannedLanguage(util.getCodeQLDatabasePath(config.tempDir, language), language);
      logger.endGroup();
    }
  }
}

async function finalizeDatabaseCreation(
  config: configUtils.Config,
  logger: Logger) {

  await createdDBForScannedLanguages(config, logger);

  const codeql = getCodeQL(config.codeQLCmd);
  for (const language of config.languages) {
    logger.startGroup('Finalizing ' + language);
    await codeql.finalizeDatabase(util.getCodeQLDatabasePath(config.tempDir, language));
    logger.endGroup();
  }
}

// Runs queries and creates sarif files in the given folder
async function runQueries(
  sarifFolder: string,
  memoryFlag: string,
  threadsFlag: string,
  config: configUtils.Config,
  logger: Logger): Promise<QueriesStatusReport> {

  const codeql = getCodeQL(config.codeQLCmd);
  for (let language of config.languages) {
    logger.startGroup('Analyzing ' + language);

    const queries = config.queries[language] || [];
    if (queries.length === 0) {
      throw new Error('Unable to analyse ' + language + ' as no queries were selected for this language');
    }

    try {
      const databasePath = util.getCodeQLDatabasePath(config.tempDir, language);
      // Pass the queries to codeql using a file instead of using the command
      // line to avoid command line length restrictions, particularly on windows.
      const querySuite = databasePath + '-queries.qls';
      const querySuiteContents = queries.map(q => '- query: ' + q).join('\n');
      fs.writeFileSync(querySuite, querySuiteContents);
      logger.debug('Query suite file for ' + language + '...\n' + querySuiteContents);

      const sarifFile = path.join(sarifFolder, language + '.sarif');

      await codeql.databaseAnalyze(databasePath, sarifFile, querySuite, memoryFlag, threadsFlag);

      logger.debug('SARIF results for database ' + language + ' created at "' + sarifFile + '"');
      logger.endGroup();

    } catch (e) {
      // For now the fields about query performance are not populated
      return {
        analyze_failure_language: language,
      };
    }
  }

  return {};
}

export async function runAnalyze(
  repositoryNwo: RepositoryNwo,
  commitOid: string,
  ref: string,
  analysisKey: string | undefined,
  analysisName: string | undefined,
  workflowRunID: number | undefined,
  checkoutPath: string,
  environment: string | undefined,
  githubAuth: string,
  githubUrl: string,
  doUpload: boolean,
  mode: util.Mode,
  outputDir: string,
  memoryFlag: string,
  threadsFlag: string,
  config: configUtils.Config,
  logger: Logger): Promise<AnalysisStatusReport> {

  // Delete the tracer config env var to avoid tracing ourselves
  delete process.env[sharedEnv.ODASA_TRACER_CONFIGURATION];

  fs.mkdirSync(outputDir, { recursive: true });

  logger.info('Finalizing database creation');
  await finalizeDatabaseCreation(config, logger);

  logger.info('Analyzing database');
  const queriesStats = await runQueries(outputDir, memoryFlag, threadsFlag, config, logger);

  if (!doUpload) {
    logger.info('Not uploading results');
    return { ...queriesStats };
  }

  const uploadStats = await upload_lib.upload(
    outputDir,
    repositoryNwo,
    commitOid,
    ref,
    analysisKey,
    analysisName,
    workflowRunID,
    checkoutPath,
    environment,
    githubAuth,
    githubUrl,
    mode,
    logger);

  return { ...queriesStats, ...uploadStats };
}
