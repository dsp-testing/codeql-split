import * as toolrunnner from '@actions/exec/lib/toolrunner';
import * as fs from 'fs';
import * as path from 'path';

import * as analysisPaths from './analysis-paths';
import { CodeQL, setupCodeQL } from './codeql';
import * as configUtils from './config-utils';
import {Language} from './languages';
import { Logger } from './logging';
import { getCombinedTracerConfig, TracerConfig } from './tracer-config';
import * as util from './util';


export async function initCodeQL(
  codeqlURL: string | undefined,
  languages: Language[],
  githubAuth: string,
  githubUrl: string,
  tempDir: string,
  toolsDir: string,
  mode: util.Mode,
  logger: Logger): Promise<CodeQL> {

  logger.startGroup('Setup CodeQL tools');

  const codeql = await setupCodeQL(
    codeqlURL,
    languages,
    githubAuth,
    githubUrl,
    tempDir,
    toolsDir,
    mode,
    logger);
  await codeql.printVersion();
  logger.endGroup();
  return codeql;
}

export async function initConfig(
  languages: Language[],
  queriesInput: string | undefined,
  configFile: string | undefined,
  tempDir: string,
  toolCacheDir: string,
  codeQL: CodeQL,
  checkoutPath: string,
  githubAuth: string,
  githubUrl: string,
  logger: Logger): Promise<configUtils.Config> {

  logger.startGroup('Load language configuration');
  const config = await configUtils.initConfig(
    languages,
    queriesInput,
    configFile,
    tempDir,
    toolCacheDir,
    codeQL,
    checkoutPath,
    githubAuth,
    githubUrl,
    logger);
  analysisPaths.printPathFiltersWarning(config, logger);
  logger.endGroup();
  return config;
}

export async function runInit(
  codeql: CodeQL,
  config: configUtils.Config): Promise<TracerConfig | undefined> {

  const sourceRoot = path.resolve();

  fs.mkdirSync(util.getCodeQLDatabasesDir(config.tempDir), { recursive: true });

  // TODO: replace this code once CodeQL supports multi-language tracing
  for (let language of config.languages) {
    // Init language database
    await codeql.databaseInit(util.getCodeQLDatabasePath(config.tempDir, language), language, sourceRoot);
  }

  return await getCombinedTracerConfig(config, codeql);
}

// Runs a powershell script to inject the tracer into a parent process
// so it can tracer future processes, hopefully including the build process.
// If processName is given then injects into the nearest parent process with
// this name, otherwise uses the processLevel-th parent if defined, otherwise
// defaults to the 3rd parent as a rough guess.
export async function injectWindowsTracer(
  processName: string | undefined,
  processLevel: number | undefined,
  config: configUtils.Config,
  codeql: CodeQL,
  tracerConfig: TracerConfig) {

  let script: string;
  if (processName !== undefined) {
    script = `
      Param(
          [Parameter(Position=0)]
          [String]
          $tracer
      )

      $id = $PID
      while ($true) {
        $p = Get-CimInstance -Class Win32_Process -Filter "ProcessId = $id"
        Write-Host "Found process: $p"
        if ($p -eq $null) {
          throw "Could not determine ${processName} process"
        }
        if ($p[0].Name -eq "${processName}") {
          Break
        } else {
          $id = $p[0].ParentProcessId
        }
      }
      Write-Host "Final process: $p"

      Invoke-Expression "&$tracer --inject=$id"`;
  } else {
    // If the level is not defined then guess at the 3rd parent process.
    // This won't be correct in every setting but it should be enough in most settings,
    // and overestimating is likely better in this situation so we definitely trace
    // what we want, though this does run the risk of interfering with future CI jobs.
    // Note that the default of 3 doesn't work on github actions, so we include a
    // special case in the script that checks for Runner.Worker.exe so we can still work
    // on actions if the runner is invoked there.
    processLevel = processLevel || 3;
    script = `
      Param(
          [Parameter(Position=0)]
          [String]
          $tracer
      )

      $id = $PID
      for ($i = 0; $i -le ${processLevel}; $i++) {
        $p = Get-CimInstance -Class Win32_Process -Filter "ProcessId = $id"
        Write-Host "Parent process \${i}: $p"
        if ($p -eq $null) {
          throw "Process tree ended before reaching required level"
        }
        # Special case just in case the runner is used on actions
        if ($p[0].Name -eq "Runner.Worker.exe") {
          Write-Host "Found Runner.Worker.exe process which means we are running on GitHub Actions"
          Write-Host "Aborting search early and using process: $p"
          Break
        } else {
          $id = $p[0].ParentProcessId
        }
      }
      Write-Host "Final process: $p"

      Invoke-Expression "&$tracer --inject=$id"`;
  }

  const injectTracerPath = path.join(config.tempDir, 'inject-tracer.ps1');
  fs.writeFileSync(injectTracerPath, script);

  await new toolrunnner.ToolRunner(
    'powershell',
    [
      '-ExecutionPolicy', 'Bypass',
      '-file', injectTracerPath,
      path.resolve(path.dirname(codeql.getPath()), 'tools', 'win64', 'tracer.exe'),
    ],
    { env: { 'ODASA_TRACER_CONFIGURATION': tracerConfig.spec } }).exec();
}
