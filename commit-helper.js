const existsSync = require('fs').existsSync;
const readFileSync = require('fs').readFileSync;
const basename = require('path').basename;
const getApiDriver = require('./util.js').getApiDriver;
const diffLines =  require("diff").diffLines;


/**
 * Commits a single file to the defined repository.
 * @param {string} localFile Local file relative to execution directory.
 * @param {string} projectIdentifier Id or project path.
 * @param {string} [remoteFile] Path of the remote file location relative to remote project root. Basename of local file is used if undefined of null
 * @param {Object} options Options.
 * @param {string} options.url  github url.
 * @param {string} options.access_token github access token.
 * @param {string} options.ref ref (e.g. branch) to be pushed to.
 * @param {boolean} options.verbose verbose console output.
 * @param {boolean} options.force commit even if there is no change in file (--allow-empty)
 * @param {string} options.message custom commit message
 */
async function commitSingleFile(localFile, projectIdentifier, remoteFile, options) {
    const VERBOSE = options.verbose || false;
    const FORCE = options.force || false;
    const api = getApiDriver(options);

    if (!existsSync(localFile)) {
        throw new Error(`Error: to-be-committed file '${localFile}' does not exist`)
    }

    if (typeof remoteFile === 'undefined' || remoteFile === null) {
        remoteFile = basename(localFile);
        if (VERBOSE) console.log(`Remote file is not given. Hence, basename of local file will be used: '${remoteFile}'`);
    }

    let targetBranch = options.ref;
    if (typeof ref === 'undefined') {
        const defaultBranch = (await api.getProject(projectIdentifier)).default_branch;
        if (VERBOSE) console.log(`'ref' is not specified. Using default branch '${defaultBranch}'`);
        targetBranch = defaultBranch;
    }

    const ascii = fileIsAscii(localFile);

    const localFileData = ascii ? readFileSync(localFile, 'utf8') : readFileSync(localFile).toString("base64");

    const remoteFileExists = await api.fileExists(projectIdentifier, remoteFile, targetBranch);
    let commitObject = {
        "branch": targetBranch,
        "commit_message": options.message || `${remoteFileExists ? 'Updated' : 'Created'} '${remoteFile}'`,
        "actions": []
    }

    let identical = false;
    if (remoteFileExists && !FORCE) {
        let existingFileData = await api.getRawFile(projectIdentifier, remoteFile, targetBranch);
        if(ascii) {
            existingFileData = existingFileData.toString("utf8");
        }
        else {
            existingFileData = existingFileData.toString("base64");
        }
        try {
            let diff;
            if(ascii) diff = diffLines(localFileData.replace(/\r/g, ""), existingFileData.replace(/\r/g, ""));
            else diff = diffLines(localFileData, existingFileData);
            let diffFound = false;
            for (let part of diff) {
                if (part.added || part.removed) {
                    diffFound = true;
                    break;
                }
            }
            if (!diffFound) {
                identical = true;
                if(VERBOSE) console.log(`Diff shows files are identical`);
            }
            else {
                if(VERBOSE) console.log(`Diff shows files are NOT identical`);
            }
        }
        catch (e) {
            // unable to perform diff
            if(VERBOSE) console.log(`Unable to perform diff. Forcing commit`);
            identical = false;
        }
    }

    if (!identical || FORCE) {
        if(VERBOSE) console.log(`File '${remoteFile}' will be committed`);
        commitObject["actions"].push({
            "action": remoteFileExists ? "update" : "create",
            "file_path": remoteFile,
            "content": localFileData,
            "encoding": ascii ? "text" : "base64"
        })
    } else {
        if(VERBOSE) console.log(`File '${remoteFile}' remains unchanged. skipping.`);
    }
    if (commitObject["actions"].length !== 0) {
        try {
            if(VERBOSE) console.dir(commitObject)
            await api.postCommit(projectIdentifier, commitObject);
            console.log(`Committed '${remoteFile}'`);
        } catch (e) {
            console.log(`Error committing changes to project identified by '${projectIdentifier}' on branch '${targetBranch}'\nCommit object:\n${commitObject}\nOriginal Error:\n${e}`)
        }
    } else {
        console.log("Nothing to commit");
    }
}

function fileIsAscii(filename) {
    const buf = readFileSync(filename);
    var isAscii = true;
    for (var i=0, len=buf.length; i<len; i++) {
        if (buf[i] > 127) { isAscii=false; break; }
    }
    return isAscii;
}

module.exports.commitSingleFile = commitSingleFile;