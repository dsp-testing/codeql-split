"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const languages_1 = require("./languages");
const util = __importStar(require("./util"));
const CRITICAL_TRACER_VARS = new Set(['SEMMLE_PRELOAD_libtrace',
    ,
    'SEMMLE_RUNNER',
    ,
    'SEMMLE_COPY_EXECUTABLES_ROOT',
    ,
    'SEMMLE_DEPTRACE_SOCKET',
    ,
    'SEMMLE_JAVA_TOOL_OPTIONS'
]);
async function getTracerConfigForLanguage(codeql, config, language) {
    const env = await codeql.getTracerEnv(util.getCodeQLDatabasePath(config.tempDir, language));
    const spec = env['ODASA_TRACER_CONFIGURATION'];
    const info = { spec, env: {} };
    // Extract critical tracer variables from the environment
    for (let entry of Object.entries(env)) {
        const key = entry[0];
        const value = entry[1];
        // skip ODASA_TRACER_CONFIGURATION as it is handled separately
        if (key === 'ODASA_TRACER_CONFIGURATION') {
            continue;
        }
        // skip undefined values
        if (typeof value === 'undefined') {
            continue;
        }
        // Keep variables that do not exist in current environment. In addition always keep
        // critical and CODEQL_ variables
        if (typeof process.env[key] === 'undefined' || CRITICAL_TRACER_VARS.has(key) || key.startsWith('CODEQL_')) {
            info.env[key] = value;
        }
    }
    return info;
}
exports.getTracerConfigForLanguage = getTracerConfigForLanguage;
function concatTracerConfigs(tracerConfigs, config) {
    // A tracer config is a map containing additional environment variables and a tracer 'spec' file.
    // A tracer 'spec' file has the following format [log_file, number_of_blocks, blocks_text]
    // Merge the environments
    const env = {};
    let copyExecutables = false;
    let envSize = 0;
    for (const v of Object.values(tracerConfigs)) {
        for (let e of Object.entries(v.env)) {
            const name = e[0];
            const value = e[1];
            // skip SEMMLE_COPY_EXECUTABLES_ROOT as it is handled separately
            if (name === 'SEMMLE_COPY_EXECUTABLES_ROOT') {
                copyExecutables = true;
            }
            else if (name in env) {
                if (env[name] !== value) {
                    throw Error('Incompatible values in environment parameter ' +
                        name + ': ' + env[name] + ' and ' + value);
                }
            }
            else {
                env[name] = value;
                envSize += 1;
            }
        }
    }
    // Concatenate spec files into a new spec file
    let languages = Object.keys(tracerConfigs);
    const cppIndex = languages.indexOf('cpp');
    // Make sure cpp is the last language, if it's present since it must be concatenated last
    if (cppIndex !== -1) {
        let lastLang = languages[languages.length - 1];
        languages[languages.length - 1] = languages[cppIndex];
        languages[cppIndex] = lastLang;
    }
    let totalLines = [];
    let totalCount = 0;
    for (let lang of languages) {
        const lines = fs.readFileSync(tracerConfigs[lang].spec, 'utf8').split(/\r?\n/);
        const count = parseInt(lines[1], 10);
        totalCount += count;
        totalLines.push(...lines.slice(2));
    }
    const newLogFilePath = path.resolve(config.tempDir, 'compound-build-tracer.log');
    const spec = path.resolve(config.tempDir, 'compound-spec');
    const compoundTempFolder = path.resolve(config.tempDir, 'compound-temp');
    const newSpecContent = [newLogFilePath, totalCount.toString(10), ...totalLines];
    if (copyExecutables) {
        env['SEMMLE_COPY_EXECUTABLES_ROOT'] = compoundTempFolder;
        envSize += 1;
    }
    fs.writeFileSync(spec, newSpecContent.join('\n'));
    // Prepare the content of the compound environment file
    let buffer = Buffer.alloc(4);
    buffer.writeInt32LE(envSize, 0);
    for (let e of Object.entries(env)) {
        const key = e[0];
        const value = e[1];
        const lineBuffer = new Buffer(key + '=' + value + '\0', 'utf8');
        const sizeBuffer = Buffer.alloc(4);
        sizeBuffer.writeInt32LE(lineBuffer.length, 0);
        buffer = Buffer.concat([buffer, sizeBuffer, lineBuffer]);
    }
    // Write the compound environment
    const envPath = spec + '.environment';
    fs.writeFileSync(envPath, buffer);
    return { env, spec };
}
exports.concatTracerConfigs = concatTracerConfigs;
async function getCombinedTracerConfig(config, codeql) {
    // Abort if there are no traced languages as there's nothing to do
    const tracedLanguages = config.languages.filter(languages_1.isTracedLanguage);
    if (tracedLanguages.length === 0) {
        return undefined;
    }
    // Get all the tracer configs and combine them together
    const tracedLanguageConfigs = {};
    for (const language of tracedLanguages) {
        tracedLanguageConfigs[language] = await getTracerConfigForLanguage(codeql, config, language);
    }
    const mainTracerConfig = concatTracerConfigs(tracedLanguageConfigs, config);
    // Add a couple more variables
    mainTracerConfig.env['ODASA_TRACER_CONFIGURATION'] = mainTracerConfig.spec;
    const codeQLDir = path.dirname(codeql.getPath());
    if (process.platform === 'darwin') {
        mainTracerConfig.env['DYLD_INSERT_LIBRARIES'] = path.join(codeQLDir, 'tools', 'osx64', 'libtrace.dylib');
    }
    else if (process.platform !== 'win32') {
        mainTracerConfig.env['LD_PRELOAD'] = path.join(codeQLDir, 'tools', 'linux64', '${LIB}trace.so');
    }
    return mainTracerConfig;
}
exports.getCombinedTracerConfig = getCombinedTracerConfig;
//# sourceMappingURL=tracer-config.js.map