#!/usr/bin/env node
"use strict";
const log = require("console-log-level")({ level: "info" });

const yargs = require("yargs");
const fs = require("fs");
const path = require("path");

const downloadQueue = require("./support/downloadQueue");
const htmlConverter = require("./support/channelHtmlConverter");
const htmlConverterSidebar = require("./support/archiveHtmlConverter");

const OUTPUT_DIRECTORY = "output_html";
const STATIC_FILES_DIRECTORY = "static_files";
const STATIC_FILES = ["styles.css", "file-icon.webp", "archive-scripts.js", "channel-scripts.js"];

/////////////////////////////////////////////
//
// file downloading
//
/////////////////////////////////////////////

function downloadFiles(messages, channelName) {
  const filesToDownload = [];

  // parse json to get the url and to append the new local file name
  messages.forEach((m) => {
    // ignore deleted files
    m.files = m.files.filter((f) => f.mode !== "tombstone");
    m.files.forEach((f) => {
      const url = f["url_private_download"];
      const fileName = f.id + "_" + f.created + "_" + f.name;

      // writes the new filename and relative path to the JSON file,
      f["local_file"] = path.posix.join(channelName, fileName);

      createDirIfItDoesntExist(path.join(OUTPUT_DIRECTORY, channelName));

      const downloadDetails = {
        url: url,
        outputPath: path.join(OUTPUT_DIRECTORY, channelName, fileName),
      };
      if (fs.existsSync(downloadDetails.outputPath)) {
        log.debug("file already exists, skipping download: ", fileName);
      } else {
        filesToDownload.push(downloadDetails);
      }
    });
  });

  return downloadQueue(filesToDownload);
}

/////////////////////////////////////////////
//
// file utils
//
/////////////////////////////////////////////

function readFileFromDisk(fileName) {
  let rawdata = fs.readFileSync(fileName);
  let archive = JSON.parse(rawdata);
  return archive;
}

function createDirIfItDoesntExist(path) {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path);
  }
}

/////////////////////////////////////////////
//
// open the directory and get all filenames
//
/////////////////////////////////////////////

function readChannelAndDownloadImages(baseDir, channelName, userProfilesDict) {
  let dirName = path.join(baseDir, channelName);

  fs.readdir(dirName, function (err, items) {
    log.info(`\nProcessing slack channel '${channelName}'.`);

    //
    // first: parse archive files
    //
    let messagesCombined = [];
    for (var i = 0; i < items.length; i++) {
      // log.debug(items[i]);
      var fileName = path.join(dirName, items[i]);

      let messages = readFileFromDisk(fileName);
      log.debug("Reading messages file '%s', it contains %d messages.", fileName, messages.length);

      messagesCombined.push(...messages);
    }
    let msgWithImgs = messagesCombined.filter((m) => m.files && m.files.length > 0);

    //
    // second: update jsons with local filename & download attachment files
    //
    downloadFiles(msgWithImgs, channelName).then(() => {
      //
      // third: convert to html
      //
      log.info(`Converting ${messagesCombined.length} JSON messages to HTML.`);
      htmlConverter(messagesCombined, channelName, userProfilesDict);
    });
  });
}

function processChannelSubdir(baseDir, channelName, userProfilesDict) {
  readChannelAndDownloadImages(baseDir, channelName, userProfilesDict);
}

function processArchiveDir(archiveDir) {
  log.debug(`Processing slack archive directory '${archiveDir}'.`);

  const createUserProfilesDict = () => {
    const users = JSON.parse(fs.readFileSync(`${archiveDir}/users.json`, "utf-8"));
    return users.reduce((acc, cur) => ({ ...acc, [cur.id]: cur.profile }), {});
  };
  let userProfilesDict;
  try {
    userProfilesDict = createUserProfilesDict();
  } catch (error) {
    throw new error("Failed to create user profiles dictionary from archive folder users.json file", error);
  }

  fs.readdir(archiveDir, function (err, items) {
    let channelDirs = items.filter((i) => fs.statSync(path.join(archiveDir, i)).isDirectory());
    log.debug(`Processing slack archive, ${channelDirs.length} channel(s) found.\n`);

    channelDirs.forEach((c) => processChannelSubdir(archiveDir, c, userProfilesDict));

    htmlConverterSidebar(channelDirs);
  });
}
function processUserFile(userFilePath) {
  log.debug(`Processing user file '${userFilePath}'.`);

  const users = JSON.parse(fs.readFileSync(userFilePath, "utf-8"));
  return users.reduce((acc, cur) => ({ ...acc, [cur.id]: cur.profile }), {});
}

////////////////////////////////////////////////
//
// main
//
////////////////////////////////////////////////

const argv = yargs
  .usage("$0 <directory> [options]")
  .demandCommand(1)
  .option("c", {
    alias: "channel",
    describe: "Treat the directory as a single channel [default]",
    type: "string",
  })
  .option("a", {
    alias: "archive",
    describe: "The directory contains many channel subdirectories",
  })
  .help("h")
  .alias("h", "help")
  .example("$0 ux-design-team", "Parse the channel 'ux-design-team' subdir")
  .example("$0 ux-design-team -c", "Parse the channel 'ux-design-team' subdir")
  .example("$0 slackExport -a", "Parse all subdirs under 'slackExport\\'")
  .version(false)
  .wrap(100).argv;

let dirName = argv._[0];

log.debug("");
dirName = path.normalize(dirName);

createDirIfItDoesntExist(OUTPUT_DIRECTORY);

STATIC_FILES.forEach((f) => {
  fs.copyFile(path.join(STATIC_FILES_DIRECTORY, f), path.join(OUTPUT_DIRECTORY, f), () =>
    log.debug("Copied static file to output folder", f)
  );
});

if (argv.a) {
  processArchiveDir(dirName);
} else {
  let channelName = path.basename(dirName);
  let baseDir = path.dirname(dirName);
  processChannelSubdir(baseDir, channelName);
}
