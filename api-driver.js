const axios = require("axios");
const util = require("./util.js");
const fs = require("fs-extra");
const path = require("path");
const unzipper = require("unzipper");

const API_PATH = ``;

class GitHubApiDriver {
  constructor(baseUrl, accessToken, verbose) {
    this.VERBOSE = verbose;
    this.BASE_URL = util.trimTailingSlash(baseUrl);

    if (this.BASE_URL.startsWith("http://")) {
      this.BASE_URL = this.BASE_URL.replace("http://", "https://");
    }
    if (!this.BASE_URL.startsWith("https://")) {
      this.BASE_URL = `https://${this.BASE_URL}`;
    }

    this.API_URL = `${this.BASE_URL}${API_PATH}`;
    this.AT = accessToken;
    this.config = { headers: { Authorization: `token ${this.AT}` } };
  }

  getProjectUrl(identifier) {
    const resolvedIdentifier = util.resolveProjectIdentifier(
      this.BASE_URL,
      identifier
    );
    if (typeof resolvedIdentifier.path !== "undefined") {
      return `${this.API_URL}/repos/${resolvedIdentifier.path}`;
    } else {
      throw new Error(`'${identifier}' is an invalid identifier for a project`);
    }
  }

  async getProject(identifier) {
    const url = this.getProjectUrl(identifier);
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.get(url, this.config);
      return res.data;
    } catch (e) {
      throw new GitHubApiError(
        `Error requesting project identified by '${identifier}'\n\nOriginal Error:\n${e}`
      );
    }
  }

  async getBranches(projectIdentifier) {
    const url = `${this.getProjectUrl(projectIdentifier)}/branches`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.get(url, this.config);
      return res.data;
    } catch (e) {
      throw new GitHubApiError(
        `Error requesting branchs for project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
      );
    }
  }

  async branchExists(projectId, branchName) {
    const url = `${this.API_URL}/projects/${projectId}/branches/${branchName}`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.get(url, this.config);
      return res.status === 200;
    } catch (e) {
      if (typeof e.response !== "undefined" && e.response.status === 404) {
        return false;
      } else {
        throw new GitHubApiError(
          `Error requesting branch '${branchName}' for project ID '${projectId}'\n\nOriginal Error:\n${e}`
        );
      }
    }
  }

  async fileExists(projectIdentifier, filePath, branchName) {
    if (typeof branchName === "undefined") {
      branchName = (await this.getProject(projectIdentifier)).default_branch;
    }
    const encodedFilePath = encodeURIComponent(util.trimSlashes(filePath));
    const url = `${this.getProjectUrl(
      projectIdentifier
    )}/contents/${encodedFilePath}?ref=${branchName}`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.get(url, this.config);
      return res.status === 200;
    } catch (e) {
      if (typeof e.response !== "undefined" && e.response.status === 404) {
        return false;
      } else {
        throw new GitHubApiError(
          `Error requesting file '${filePath}' from branch '${branchName}' for project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
        );
      }
    }
  }

  /**
   * commitObject:
   *   branch: string
   *   commit_message: string
   *   actions: [
   *     {
   *       action: "update"
   *       file_path: string
   *       content: string
   *       encoding: text
   *     }
   *   ]
   */
  async postCommit(projectIdentifier, commitObject) {
    let branch = commitObject.branch;
    if (!branch) {
      const project = await this.getProject(projectIdentifier);
      branch = project.default_branch;
    }
    const branches = await this.getBranches(projectIdentifier);
    if (!branches.find((b) => b.name === branch)) {
      throw new Error(
        `Branch '${branch}' does not exist for project '${projectIdentifier}'`
      );
    }
    const commitSha = branches.find((b) => b.name === branch).commit.sha;

    // commit file blob
    const fileBlobUrl = `${this.getProjectUrl(projectIdentifier)}/git/blobs`;
    const config = {
      headers: {
        Authorization: `token ${this.AT}`,
        "Content-Type": "application/json",
      },
    };
    try {
      if (this.VERBOSE) console.log(`POST > ${url}`);
      const blobs = [];
      for (const action of commitObject.actions) {
        const blobRes = await axios.post(
          fileBlobUrl,
          {
            encoding: "base64",
            content: Buffer.from(action.content).toString("base64"),
          },
          config
        );
        if (blobRes.status === 201 || blobRes.status === 200) {
          blobs.push({ blob: blobRes.data, ...action });
        }
      }
      const treeUrl = `${this.getProjectUrl(projectIdentifier)}/git/trees`;
      const treeRes = await axios.post(
        treeUrl,
        {
          base_tree: commitSha,
          tree: blobs.map((b) => ({
            path: b.file_path,
            mode: "100644",
            type: "blob",
            sha: b.blob.sha,
          })),
        },
        config
      );
      if (treeRes.status !== 201 && treeRes.status !== 200) {
        throw new Error(`Error creating tree for commit: ${treeRes.status}`);
      }
      const commitUrl = `${this.getProjectUrl(projectIdentifier)}/git/commits`;
      const commitRes = await axios.post(commitUrl, {
        message: commitObject.commit_message,
        tree: treeRes.data.sha,
        parents: [commitSha],
      }, config);
      if (commitRes.status !== 201 && commitRes.status !== 200) {
        throw new Error(`Error creating commit: ${commitRes.status}`);
      }
      const updateBranchUrl = `${this.getProjectUrl(
        projectIdentifier
      )}/git/refs/heads/${branch}`;
      const updateBranchRes = await axios.patch(updateBranchUrl, {
        sha: commitRes.data.sha,
        ref: `refs/heads/${branch}`,
      }, config);
      return updateBranchRes.status === 201;
    } catch (e) {
      throw new GitHubApiError(
        `Error executing commit on project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
      );
    }
  }

  /*async postSnippetCommit(snippetId, commitObject) {
    const url = `${this.API_URL}/snippets/${snippetId}`;
    const config = {
      headers: {
        "PRIVATE-TOKEN": this.AT,
        "Content-Type": "application/json",
      },
    };
    try {
      if (this.VERBOSE) console.log(`PUT > ${url}`);
      const res = await axios.put(url, commitObject, config);
      return res.status === 201;
    } catch (e) {
      throw new GitHubApiError(
        `Error executing commit on snippet ID '${snippetId}'\n\nOriginal Error:\n${e}`
      );
    }
  }*/

  async getRawFile(projectIdentifier, filePath, branchName) {
    if (typeof branchName === "undefined") {
      branchName = (await this.getProject(projectIdentifier)).default_branch;
    }
    const encodedFilePath = encodeURIComponent(util.trimSlashes(filePath));
    const url = `${this.getProjectUrl(
      projectIdentifier
    )}/contents/${encodedFilePath}?ref=${branchName}`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.request({
        url: url,
        method: "get",
        headers: {
          Authorization: `token ${this.AT}`,
          Accept: "application/vnd.github.v3.raw",
        },
      });
      if (res.status === 200) {
        return res.data;
      }
    } catch (e) {
      throw new GitHubApiError(
        `Error requesting raw file '${filePath}' from branch '${branchName}' for project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
      );
    }
  }

  /*async getLatestArtifact(
    projectIdentifier,
    artifactPath,
    branchName,
    jobName
  ) {
    if (typeof branchName === "undefined") {
      branchName = (await this.getProject(projectIdentifier)).default_branch;
    }
    const encodedArtifactPath = encodeURIComponent(
      util.trimSlashes(artifactPath)
    );
    const url = `${this.getProjectUrl(
      projectIdentifier
    )}/jobs/artifacts/${branchName}/raw/${encodedArtifactPath}?job=${jobName}`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.request({
        responseType: "arraybuffer",
        url: url,
        method: "get",
        headers: {
          "PRIVATE-TOKEN": this.AT,
        },
      });
      if (res.status === 200) {
        return res.data;
      }
    } catch (e) {
      throw new GitHubApiError(
        `Error requesting artifact '${artifactPath}' generated by job '${jobName}' from branch '${branchName}' for project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
      );
    }
  }*/

  /*async getAllFiles(projectIdentifier, branchName) {
    if (typeof branchName === "undefined") {
      branchName = (await this.getProject(projectIdentifier)).default_branch;
    }
    let files = [];
    let currentPage = 1;
    let totalPages = 1;
    while (currentPage <= totalPages) {
      const url = `${this.getProjectUrl(
        projectIdentifier
      )}/repository/tree/?ref=${branchName}&recursive=true&per_page=100&page=${currentPage}`;
      try {
        if (this.VERBOSE) console.log(`GET > ${url}`);
        const res = await axios.get(url, this.config);
        files = files.concat(res.data);
        const totalPagesHeader = res.headers["x-total-pages"];
        if (
          typeof totalPagesHeader !== "undefined" &&
          totalPages !== totalPagesHeader
        ) {
          totalPages = totalPagesHeader;
          if (this.VERBOSE)
            console.log(`Set total pages to ${totalPagesHeader}`);
        }
        ++currentPage;
      } catch (e) {
        throw new GitHubApiError(
          `Error requesting files from branch '${branchName}' for project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
        );
      }
    }
    return files;
  }*/

  /* async loadRepository(projectIdentifier, branchName, directory, force) {
        if(typeof branchName === 'undefined') {
            branchName = (await this.getProject(projectIdentifier)).default_branch;
        }
        let cleanRequired = false;
        if(fs.existsSync(directory)) {
            if(fs.lstatSync(directory).isDirectory()) {
                if(this.VERBOSE) console.log(`Target location '${directory}' exists`);
                const files = fs.readdirSync(directory);
                if(files.length !== 0) {
                    if(this.VERBOSE) console.log(`Target location is not empty`);
                    cleanRequired = true;
                    if(!force) {
                        console.log("Error: target location is not empty. User 'force' to ignore.")
                        return;
                    }
                }
            }
            else {
                console.log("Error: target location is a file")
                return;
            }
        }
        else {
            fs.mkdirSync(directory);    
        }

        let manifest = null;
        if(fs.existsSync(path.join(directory, ".github-x"))) {
            manifest = fs.readJSONSync(path.join(directory, ".github-x"));
        }

        if(cleanRequired) {
            if(manifest !== null) {
                const localFiles = util.walk(directory);
                for(let localFile of localFiles) {
                    for(const entry of manifest) {
                        const fileName = path.join(directory, entry.path);
                        // TODO remove added or modified files
                    }
                }
            }
            else {
                fs.emptyDirSync(directory);
            }
        }

        let remoteFileManifest = await this.getAllFiles(projectIdentifier, branchName);
        for(const file of remoteFileManifest) {
            if(file.type === "tree") {
                const filePath = path.join(directory, file.path);
                fs.ensureDirSync(filePath);
            }
        }

        for(let file of remoteFileManifest) {
            if(file.type === "blob") {
                const data = await this.getRawFile(projectIdentifier, file.path, branchName);
                file.checksum = crypto.createHash('sha1').update(data).digest("hex");
                const filePath = path.join(directory, file.path);
                fs.writeFileSync(filePath, data);
            }
        }

        fs.writeJSONSync(path.join(directory, ".github-x"), remoteFileManifest);
    } */

  /*async loadRepository(projectIdentifier, branchName, directory, force) {
    if (typeof branchName === "undefined") {
      branchName = (await this.getProject(projectIdentifier)).default_branch;
    }
    let cleanRequired = false;
    if (fs.existsSync(directory)) {
      if (fs.lstatSync(directory).isDirectory()) {
        if (this.VERBOSE) console.log(`Target location '${directory}' exists`);
        const files = fs.readdirSync(directory);
        if (files.length !== 0) {
          if (this.VERBOSE) console.log(`Target location is not empty`);
          cleanRequired = true;
          if (!force) {
            console.log(
              "Error: target location is not empty. User 'force' to ignore."
            );
            return;
          }
        }
      } else {
        console.log("Error: target location is a file");
        return;
      }
    } else {
      fs.mkdirSync(directory);
    }

    if (cleanRequired) {
      fs.emptyDirSync(directory);
    }

    const url = `${this.getProjectUrl(
      projectIdentifier
    )}/repository/archive.zip?sha=${branchName}`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.request({
        responseType: "arraybuffer",
        url: url,
        method: "get",
        headers: {
          "PRIVATE-TOKEN": this.AT,
        },
      });
      const zip = await unzipper.Open.buffer(res.data);
      await zip.extract({ path: path.resolve(directory) });
      const files = fs.readdirSync(directory);
      if (
        files.length === 1 &&
        fs.lstatSync(path.join(directory, files[0])).isDirectory()
      ) {
        const zipParentDir = path.join(directory, files[0]);
        for (const f of fs.readdirSync(zipParentDir)) {
          fs.moveSync(path.join(zipParentDir, f), path.join(directory, f));
        }
        if (fs.readdirSync(zipParentDir).length === 0) {
          fs.removeSync(zipParentDir);
        }
      }
    } catch (e) {
      throw new GitHubApiError(
        `Error downloading repo archive from branch '${branchName}' for project identified by '${projectIdentifier}'\n\nOriginal Error:\n${e}`
      );
    }
  }*/

  async getVersion() {
    const url = `${this.API_URL}`;
    try {
      if (this.VERBOSE) console.log(`GET > ${url}`);
      const res = await axios.get(url, this.config);
      if (res.status === 200) {
        return res.data;
      } else {
        return null;
      }
    } catch (e) {
      throw new GitHubApiError(
        `Error retrieving API information.\n\nOriginal Error:\n${e}`
      );
    }
  }
}

class GitHubApiError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports.GitHubApiDriver = GitHubApiDriver;
module.exports.GitHubApiError = GitHubApiError;
