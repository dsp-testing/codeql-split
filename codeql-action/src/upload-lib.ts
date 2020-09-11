import * as core from '@actions/core';
import fileUrl from 'file-url';
import * as fs from 'fs';
import * as jsonschema from 'jsonschema';
import * as path from 'path';
import zlib from 'zlib';

import * as api from './api-client';
import * as fingerprints from './fingerprints';
import { Logger } from './logging';
import { RepositoryNwo } from './repository';
import * as sharedEnv from './shared-environment';
import * as util from './util';

// Takes a list of paths to sarif files and combines them together,
// returning the contents of the combined sarif file.
export function combineSarifFiles(sarifFiles: string[]): string {
  let combinedSarif = {
    version: null,
    runs: [] as any[]
  };

  for (let sarifFile of sarifFiles) {
    let sarifObject = JSON.parse(fs.readFileSync(sarifFile, 'utf8'));
    // Check SARIF version
    if (combinedSarif.version === null) {
      combinedSarif.version = sarifObject.version;
    } else if (combinedSarif.version !== sarifObject.version) {
      throw "Different SARIF versions encountered: " + combinedSarif.version + " and " + sarifObject.version;
    }

    combinedSarif.runs.push(...sarifObject.runs);
  }

  return JSON.stringify(combinedSarif);
}

// Upload the given payload.
// If the request fails then this will retry a small number of times.
async function uploadPayload(
  payload: any,
  repositoryNwo: RepositoryNwo,
  githubAuth: string,
  githubUrl: string,
  mode: util.Mode,
  logger: Logger) {

  logger.info('Uploading results');

  // If in test mode we don't want to upload the results
  const testMode = process.env['TEST_MODE'] === 'true' || false;
  if (testMode) {
    return;
  }

  // Make up to 4 attempts to upload, and sleep for these
  // number of seconds between each attempt.
  // We don't want to backoff too much to avoid wasting action
  // minutes, but just waiting a little bit could maybe help.
  const backoffPeriods = [1, 5, 15];

  const client = api.getApiClient(githubAuth, githubUrl);

  for (let attempt = 0; attempt <= backoffPeriods.length; attempt++) {
    const reqURL = mode === 'actions'
      ? 'PUT /repos/:owner/:repo/code-scanning/analysis'
      : 'POST /repos/:owner/:repo/code-scanning/sarifs';
    const response = await client.request(reqURL, ({
      owner: repositoryNwo.owner,
      repo: repositoryNwo.repo,
      data: payload,
    }));

    logger.debug('response status: ' + response.status);

    const statusCode = response.status;
    if (statusCode === 202) {
      logger.info("Successfully uploaded results");
      return;
    }

    const requestID = response.headers["x-github-request-id"];

    // On any other status code that's not 5xx mark the upload as failed
    if (!statusCode || statusCode < 500 || statusCode >= 600) {
      throw new Error('Upload failed (' + requestID + '): (' + statusCode + ') ' + JSON.stringify(response.data));
    }

    // On a 5xx status code we may retry the request
    if (attempt < backoffPeriods.length) {
      // Log the failure as a warning but don't mark the action as failed yet
      logger.warning('Upload attempt (' + (attempt + 1) + ' of ' + (backoffPeriods.length + 1) +
        ') failed (' + requestID + '). Retrying in ' + backoffPeriods[attempt] +
        ' seconds: (' + statusCode + ') ' + JSON.stringify(response.data));
      // Sleep for the backoff period
      await new Promise(r => setTimeout(r, backoffPeriods[attempt] * 1000));
      continue;

    } else {
      // If the upload fails with 5xx then we assume it is a temporary problem
      // and not an error that the user has caused or can fix.
      // We avoid marking the job as failed to avoid breaking CI workflows.
      throw new Error('Upload failed (' + requestID + '): (' + statusCode + ') ' + JSON.stringify(response.data));
    }
  }

  // This case shouldn't ever happen as the final iteration of the loop
  // will always throw an error instead of exiting to here.
  throw new Error('Upload failed');
}

export interface UploadStatusReport {
  // Size in bytes of unzipped SARIF upload
  raw_upload_size_bytes?: number;
  // Size in bytes of actual SARIF upload
  zipped_upload_size_bytes?: number;
  // Number of results in the SARIF upload
  num_results_in_sarif?: number;
}

// Uploads a single sarif file or a directory of sarif files
// depending on what the path happens to refer to.
// Returns true iff the upload occurred and succeeded
export async function upload(
  sarifPath: string,
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
  mode: util.Mode,
  logger: Logger): Promise<UploadStatusReport> {

  const sarifFiles: string[] = [];
  if (!fs.existsSync(sarifPath)) {
    throw new Error(`Path does not exist: ${sarifPath}`);
  }
  if (fs.lstatSync(sarifPath).isDirectory()) {
    fs.readdirSync(sarifPath)
      .filter(f => f.endsWith(".sarif"))
      .map(f => path.resolve(sarifPath, f))
      .forEach(f => sarifFiles.push(f));
    if (sarifFiles.length === 0) {
      throw new Error("No SARIF files found to upload in \"" + sarifPath + "\".");
    }
  } else {
    sarifFiles.push(sarifPath);
  }

  return await uploadFiles(
    sarifFiles,
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
}

// Counts the number of results in the given SARIF file
export function countResultsInSarif(sarif: string): number {
  let numResults = 0;
  for (const run of JSON.parse(sarif).runs) {
    numResults += run.results.length;
  }
  return numResults;
}

// Validates that the given file path refers to a valid SARIF file.
// Throws an error if the file is invalid.
export function validateSarifFileSchema(sarifFilePath: string, logger: Logger) {
  const sarif = JSON.parse(fs.readFileSync(sarifFilePath, 'utf8'));
  const schema = require('../src/sarif_v2.1.0_schema.json');

  const result = new jsonschema.Validator().validate(sarif, schema);
  if (!result.valid) {
    // Output the more verbose error messages in groups as these may be very large.
    for (const error of result.errors) {
      logger.startGroup("Error details: " + error.stack);
      logger.info(JSON.stringify(error, null, 2));
      logger.endGroup();
    }

    // Set the main error message to the stacks of all the errors.
    // This should be of a manageable size and may even give enough to fix the error.
    const sarifErrors = result.errors.map(e => "- " + e.stack);
    throw new Error("Unable to upload \"" + sarifFilePath + "\" as it is not valid SARIF:\n" + sarifErrors.join("\n"));
  }
}

// Uploads the given set of sarif files.
// Returns true iff the upload occurred and succeeded
async function uploadFiles(
  sarifFiles: string[],
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
  mode: util.Mode,
  logger: Logger): Promise<UploadStatusReport> {

  logger.info("Uploading sarif files: " + JSON.stringify(sarifFiles));

  if (mode === 'actions') {
    // This check only works on actions as env vars don't persist between calls to the runner
    const sentinelEnvVar = "CODEQL_UPLOAD_SARIF";
    if (process.env[sentinelEnvVar]) {
      throw new Error("Aborting upload: only one run of the codeql/analyze or codeql/upload-sarif actions is allowed per job");
    }
    core.exportVariable(sentinelEnvVar, sentinelEnvVar);
  }

  // Validate that the files we were asked to upload are all valid SARIF files
  for (const file of sarifFiles) {
    validateSarifFileSchema(file, logger);
  }

  let sarifPayload = combineSarifFiles(sarifFiles);
  sarifPayload = fingerprints.addFingerprints(sarifPayload, checkoutPath, logger);

  const zipped_sarif = zlib.gzipSync(sarifPayload).toString('base64');
  let checkoutURI = fileUrl(checkoutPath);

  const toolNames = util.getToolNames(sarifPayload);

  let payload: string;
  if (mode === 'actions') {
    payload = JSON.stringify({
      "commit_oid": commitOid,
      "ref": ref,
      "analysis_key": analysisKey,
      "analysis_name": analysisName,
      "sarif": zipped_sarif,
      "workflow_run_id": workflowRunID,
      "checkout_uri": checkoutURI,
      "environment": environment,
      "started_at": process.env[sharedEnv.CODEQL_WORKFLOW_STARTED_AT],
      "tool_names": toolNames,
    });
  } else {
    payload = JSON.stringify({
      "commit_sha": commitOid,
      "ref": ref,
      "sarif": zipped_sarif,
      "checkout_uri": checkoutURI,
      "tool_name": toolNames[0],
    });
  }

  // Log some useful debug info about the info
  const rawUploadSizeBytes = sarifPayload.length;
  logger.debug("Raw upload size: " + rawUploadSizeBytes + " bytes");
  const zippedUploadSizeBytes = zipped_sarif.length;
  logger.debug("Base64 zipped upload size: " + zippedUploadSizeBytes + " bytes");
  const numResultInSarif = countResultsInSarif(sarifPayload);
  logger.debug("Number of results in upload: " + numResultInSarif);

  // Make the upload
  await uploadPayload(payload, repositoryNwo, githubAuth, githubUrl, mode, logger);

  return {
    raw_upload_size_bytes: rawUploadSizeBytes,
    zipped_upload_size_bytes: zippedUploadSizeBytes,
    num_results_in_sarif: numResultInSarif,
  };
}
