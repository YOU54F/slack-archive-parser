const log = require("console-log-level")({ level: "info" });
const json2html = require("node-json2html");
const HTMLParser = require("node-html-parser");
const path = require("path");
const fs = require("fs");
const emoji = require("node-emoji");

const TEMPLATE_FILE = "channel-template.html";
const STATIC_FILES_DIRECTORY = "static_files";
const OUTPUT_DIRECTORY = "build";
const DEFAULT_USER_PROFILE_DICT_FILE = "./defaultUserProfilesDict.json";

/////////////////////////////////////////////
//
// html conversion helpers
//
/////////////////////////////////////////////

function hydrateAllUsers(data, userProfilesDict) {
  userProfilesDict = userProfilesDict ?? {};
  data.forEach(function (item) {
    if (item["user_profile"]) {
      userProfilesDict[item.user] = item["user_profile"];
    }
  });

  // add user_profile section to all messages
  data.forEach(function (item) {
    if (!item["user_profile"]) {
      item["user_profile"] = userProfilesDict[item.user];
    }
  });

  //replace references with usernames
  data
    .filter((i) => i.text.indexOf("<@") > -1)
    .forEach(function (item) {
      let text = item.text;
      var regex = RegExp(/<@([A-Z0-9]+)>/g);
      let match = regex.exec(text);
      while (match != null) {
        let user = match[1];
        if (userProfilesDict[user]) {
          text = text.replace(match[0], "<span class='mention'>@" + userProfilesDict[user]["display_name"] + "</span>");
        }
        match = regex.exec(text);
      }
      item.text = text;
    });

  return data;
}

function parseEmojis(data) {
  const onMissing = function (name) {
    log.debug("Unknown emoji: ", name);
    return ":" + name + ":";
  };

  // const slackEmojiRegexp = new RegExp(":[^:s]*(?:::[^:s]*)*:", "g");
  data.forEach((i) => {
    i.text = emoji.emojify(i.text, onMissing);
  });
}

function parseHtmlEncodedChars(data) {
  const newLineR = new RegExp("\\n", "g");
  const linkR = new RegExp("<(https?:\\/\\/([^\\>]+\\/)+[^\\>]+)>", "g");
  data.forEach((i) => {
    i.text = i.text.replace(newLineR, "<br>");
    i.text = i.text.replace(linkR, '<a href="$1">$1</a>');
  });
}

function convertTimestamp(epochTime) {
  var d = new Date(0); // The 0 there sets the date to the epoch
  d.setUTCSeconds(epochTime);
  return d.toISOString().slice(0, 19).replace(/T/g, " ");
}

/////////////////////////////////////////////
//
// define the converter template
//
/////////////////////////////////////////////
let msgTemplate = {
  "<>": "div",
  html: function (obj) {
    const brTransform = {
      "<>": "br",
    };
    const textTransform = {
      "<>": "span",
      html: "${text}",
    };
    function imgTransform(id) {
      return {
        "<>": "img",
        class: "imgFile",
        src: "${files." + id + ".local_file}",
      };
    }

    function fileTransform(id) {
      return {
        "<>": "a",
        href: "${files." + id + ".local_file}",
        target: "_blank",
        html: [
          {
            "<>": "img",
            class: "file",
            title: "${files." + id + ".local_file}",
          },
          { "<>": "span", html: "${files." + id + ".title}" },
        ],
      };
    }

    function videoTransform(id) {
      return {
        "<>": "video",
        class: "videoFile",
        controls: "true",
        src: "${files." + id + ".local_file}",
      };
    }

    const transforms = [];

    if (obj.text) {
      transforms.push(textTransform);
    }

    if (obj.files) {
      if (obj.text) {
        transforms.push(brTransform);
      }
      obj.files.forEach((f, idx) => {
        if (f.filetype === undefined) {
          console.log("undefined filetype ", f);
          return;
        }
        if (["mp4", "mov", "mkv", "webm", "avi"].indexOf(f.filetype.toLowerCase()) >= 0) {
          transforms.push(videoTransform(idx));
        } else if (["jpg", "jpeg", "png", "gif", "webp"].indexOf(f.filetype.toLowerCase()) >= 0) {
          transforms.push(imgTransform(idx));
        } else {
          transforms.push(fileTransform(idx));
        }
      });
    }

    return json2html.transform(obj, transforms);
  },
};
let template = {
  "<>": "div",
  class: function (obj) {
    let classes = "item";
    if (obj["replies"]) {
      classes += " parent";
    } else if (obj["parent_user_id"]) {
      classes += " response";
    }
    return classes;
  },
  // this is used for anchor links
  id: function (obj) {
    return convertTimestamp(obj.ts);
  },
  html: [
    {
      "<>": "img",
      class: "avatar",
      src: "${user_profile.image_72}",
    },
    {
      "<>": "div",
      class: "message",
      html: [
        {
          "<>": "div",
          class: "username",
          html: "${user_profile.display_name}",
        },
        {
          "<>": "a",
          class: "time",
          href: function (obj) {
            return "#" + convertTimestamp(obj.ts);
          },
          html: function (obj) {
            return convertTimestamp(obj.ts);
          },
        },
        {
          "<>": "div",
          class: "msg",
          html: function (obj) {
            return json2html.transform(obj, msgTemplate);
          },
        },
      ],
    },
  ],
};

function getTemplateHtml(fileName) {
  var rawData = fs.readFileSync(path.join(path.resolve(__dirname), "..", fileName));
  return HTMLParser.parse(rawData);
}

function isReply(m) {
  return m.thread_ts && !m.replies;
}
function isNotReply(m) {
  return !isReply(m);
}

function processThreads(messages) {
  let replyMessages = messages.filter(isReply);
  let parentMessages = messages.filter(isNotReply);
  let threadedMessages = [];

  // log.debug(
  //   "mgs length %d | reply length %d | newMsg length %d",
  //   initialLength,
  //   replyMessages.length,
  //   newMessages.length
  // );

  parentMessages.sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < parentMessages.length; i++) {
    const m = parentMessages[i];
    threadedMessages.push(m);

    if (m.replies) {
      m.replies.forEach((r, idx) => {
        // let idx = parentMessages.findIndex((nm) => nm.client_msg_id === m.client_msg_id);
        let reply = replyMessages.find((rm) => rm.ts === r.ts);

        // add the reply message to the new message array, in order
        threadedMessages.push(reply);
      });
    }
  }
  return threadedMessages;
}

module.exports = function (messagesCombined, channelName, userProfilesDict) {
  let root = getTemplateHtml(path.join(STATIC_FILES_DIRECTORY, TEMPLATE_FILE));
  let messagesNode = root.querySelector(".messages");

  hydrateAllUsers(messagesCombined, userProfilesDict);
  parseEmojis(messagesCombined);
  parseHtmlEncodedChars(messagesCombined);
  messagesCombined = processThreads(messagesCombined);
  let transformedHtml = json2html.transform(messagesCombined, template);
  messagesNode.appendChild(transformedHtml);

  let outputHtmlFile = path.join(OUTPUT_DIRECTORY, channelName + ".html");
  fs.writeFileSync(outputHtmlFile, root.toString());
  log.info("Done writing the channel file:", outputHtmlFile);
};
