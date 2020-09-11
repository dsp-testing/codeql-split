"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const autobuild_1 = require("./autobuild");
const config_utils = __importStar(require("./config-utils"));
const logging_1 = require("./logging");
const util = __importStar(require("./util"));
async function sendCompletedStatusReport(startedAt, allLanguages, failingLanguage, cause) {
    var _a, _b;
    const status = failingLanguage !== undefined || cause !== undefined ? 'failure' : 'success';
    const statusReportBase = await util.createStatusReportBase('autobuild', status, startedAt, (_a = cause) === null || _a === void 0 ? void 0 : _a.message, (_b = cause) === null || _b === void 0 ? void 0 : _b.stack);
    const statusReport = {
        ...statusReportBase,
        autobuild_languages: allLanguages.join(','),
        autobuild_failure: failingLanguage,
    };
    await util.sendStatusReport(statusReport);
}
async function run() {
    const logger = logging_1.getActionsLogger();
    const startedAt = new Date();
    let language = undefined;
    try {
        util.prepareLocalRunEnvironment();
        if (!await util.sendStatusReport(await util.createStatusReportBase('autobuild', 'starting', startedAt), true)) {
            return;
        }
        const config = await config_utils.getConfig(util.getRequiredEnvParam('RUNNER_TEMP'), logger);
        if (config === undefined) {
            throw new Error("Config file could not be found at expected location. Has the 'init' action been called?");
        }
        language = autobuild_1.determineAutobuildLanguage(config, logger);
        if (language !== undefined) {
            await autobuild_1.runAutobuild(language, config, logger);
        }
    }
    catch (error) {
        core.setFailed("We were unable to automatically build your code. Please replace the call to the autobuild action with your custom build steps.  " + error.message);
        console.log(error);
        await sendCompletedStatusReport(startedAt, language ? [language] : [], language, error);
        return;
    }
    await sendCompletedStatusReport(startedAt, language ? [language] : []);
}
run().catch(e => {
    core.setFailed("autobuild action failed.  " + e);
    console.log(e);
});
//# sourceMappingURL=autobuild-action.js.map