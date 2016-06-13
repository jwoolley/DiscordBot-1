var Promise = require('bluebird');
var fs = require('fs');

var qs = require("querystring");
var d20 = require("d20");
var htmlToText = require('html-to-text');

var MongoDb = require('./lib/mongo.js');
var utils = require('./lib/utils');

var http = require('http');
http.createServer(function(request, response) {
  response.writeHead(200, {"Content-Type": "text/plain"});
  response.write("Hello from the magic tavern!");
  response.end();
}).listen(process.env.PORT || 8888);

try {
	var Discord = require("discord.js");
} catch (e){
	console.log(e.stack);
	console.log(process.version);
	console.log("Please run npm install and ensure it passes with no errors!");
	process.exit();
}

var globals = {
  config: {},
  chatData: {},
  db: {}
};

var log = {
  debug: function(msg) { if (globals.config.server.debug) { console.log(msg); } },
  info: function(msg) { console.log(msg); },
  warn: function(msg) { console.log(msg); },  
  error: function(msg) { console.log(msg); },  
  ignore: function(msg) {}
};

var configs = ['server', 'auth', 'permissions', 'dieroll', 'config'];
Promise.all(configs.map(config => loadConfig(config))).then(() => { 
  // log.debug(JSON.stringify(globals.config, null, '\t')) 
  // Get authentication data
  var AuthDetails = globals.config.auth;

  // Load custom permissions
  var Permissions = globals.config.permissions;

  Permissions.checkPermission = function (user,permission) {
    try {
      var allowed = false;
      try{
        if(Permissions.global.hasOwnProperty(permission)){
          allowed = Permissions.global[permission] == true;
        }
      } catch(e){}
      try{
        if(Permissions.users[user.id].hasOwnProperty(permission)){
          allowed = Permissions.users[user.id][permission] == true;
        }
      } catch(e){}
      return allowed;
    } catch(e){}
    return false;
  }

  //load config data
  var Config = globals.config.config;
  if (Config === undefined) {
    Config = {
      debug: false,
      respondToInvalid: false
    }
  }

  var startTime = Date.now();

  var initDieRollData = function(mongo, collection) {
    //TODO: these function definitions don't belong in this init call. move everything out into a separate dieroll module
    globals.chatData.dieRolls = {
      getLowRoll: function(table, size) {
        return table.filter(roll => roll.sides == size)
          .reduce((lowest, current) => { 
            if (lowest.value === undefined || current.value < lowest.value) {
              lowest = current;
            }
            return lowest;
          }, {});
      },
      getHighRoll: function(table, size) {
        return table.filter(roll => roll.sides == size)
          .reduce((highest, current) => { 
            if (highest.value === undefined || current.value > highest.value) {
              highest = current;
            }
            return highest;
          }, {});
      },
      handleDieRolls: function(results, numSides, channel, userId) {
        log.ignore('handleDieRolls | results: ' + results + '; numSides: ' + numSides + '; channel: ' + channel + '; userId: ' + userId);

        if (!globals.db.mongo.hasOpenConnection) {
          console.log('No open mongodb connection. Skipping die roll handling.');
          return;
        }

        if (!globals.chatData.dieRolls[numSides]) {
          globals.chatData.dieRolls[numSides] = {};
        }

        var numDice = results.length;

        var timestamp = Date.now();

        var records = results.map(result => {
          return {
            value: result,
            sides: numSides,
            user: userId,
            time: timestamp
          };
        });

        log.ignore('inserting rolls: ' + JSON.stringify(records));

        try {
          globals.db.mongo.insertMany(globals.config.dieroll.mongo.collection, records);

          // log.debug('*** Global lowest: ' + globals.chatData.dieRolls[numSides].lowest + ', Global highest: ' + globals.chatData.dieRolls[numSides].highest);

          globals.chatData.dieRolls[numSides].highest = globals.chatData.dieRolls[numSides].highest ? globals.chatData.dieRolls[numSides].highest : 0;
          globals.chatData.dieRolls[numSides].lowest = globals.chatData.dieRolls[numSides].lowest ? globals.chatData.dieRolls[numSides].lowest: Number.MAX_SAFE_INTEGER;

          if (globals.config.dieroll.matches.map(match => match.sides).indexOf(parseInt(numSides)) !== -1) {

            // JACKPOT ROLL (MIN/MAX POSSIBLE ROLL)
            var targets = [1, numSides];
            var matches = targets.filter(target => { 
              return results.indexOf(target) !== -1;
            });
            matches.forEach(match => bot.sendMessage(channel, 
              '🎲 🎲 🎲 Rolled a **' + match + '** on ' + results.length + ' d' + numSides + (numDice > 1 ? 's' : '') + '! 🎲 🎲 🎲'));

            // HISTORICAL HIGH OR LOW ROLL
            var sorted = results.sort((a,b) => a - b);
            var lowest = sorted[0];
            var highest = sorted[sorted.length - 1];

            log.debug('Lowest: ' + lowest + ', Highest: ' + highest);
            log.debug('Global lowest: ' + globals.chatData.dieRolls[numSides].lowest + ', Global highest: ' + globals.chatData.dieRolls[numSides].highest);

            if (lowest < globals.chatData.dieRolls[numSides].lowest) {
              var previousLowest = globals.chatData.dieRolls[numSides].lowest;
              globals.chatData.dieRolls[numSides].lowest = lowest;
              bot.sendMessage(channel, 
              '🎲 Record broken for the lowest recorded d' + numSides + ' roll! Rolled a **' + lowest + '**. Previous low: ' + previousLowest + ' 🎲')
            }

            if (highest > globals.chatData.dieRolls[numSides].highest) {          
              var previousHighest = globals.chatData.dieRolls[numSides].highest;
              globals.chatData.dieRolls[numSides].highest = highest;
              bot.sendMessage(channel, 
              '🎲 Record broken for the highest recorded d' + numSides + ' roll! Rolled a **' + highest + '**. Previous high: ' + previousHighest + ' 🎲')
            }              
          }
        } catch (e) {
          log.error('Error saving dieroll data: ' + e);
        }
      }
    };

    globals.config.dieroll.matches.forEach(entry => {      
      var size = entry.sides;
      globals.chatData.dieRolls[size] = { lowest: size, highest: 1 };

      if (mongo) {
        return mongo.dumpTable(collection).then(result => { this.allRolls = result; log.ignore('table: ' + utils.node.inspect(result)); })
          .then(() => log.debug('Finding historical lowest and highest rolls for d' + size))
          .then(() => globals.chatData.dieRolls.getLowRoll(this.allRolls, size)).then(lowest => { log.debug('lowest roll: ' + lowest.value); globals.chatData.dieRolls[size].lowest = lowest.value; })
          .then(() => globals.chatData.dieRolls.getHighRoll(this.allRolls, size)).then(highest => { log.debug('highest roll: ' + highest.value);  globals.chatData.dieRolls[size].highest = highest.value; })      
          .catch(e => log.info('e: ' + e));
      }
    });
  };

  globals.db.mongo = new MongoDb(globals.config.dieroll.mongo.host,
    globals.config.dieroll.mongo.port, globals.config.dieroll.mongo.db);

  globals.db.mongo.open()
    .then(mongo => initDieRollData(mongo, globals.config.dieroll.mongo.collection), e => log.error('Could not open mongodb: ' + e));

  var giphy_config = {
      "api_key": "dc6zaTOxFJmzC",
      "rating": "r",
      "url": "http://api.giphy.com/v1/gifs/random",
      "permission": ["NORMAL"]
  };


  //https://api.imgflip.com/popular_meme_ids
  var meme = {
    "brace": 61546,
    "mostinteresting": 61532,
    "fry": 61520,
    "onedoesnot": 61579,
    "yuno": 61527,
    "success": 61544,
    "allthethings": 61533,
    "doge": 8072285,
    "drevil": 40945639,
    "skeptical": 101711,
    "notime": 442575,
    "yodawg": 101716
  };

  var messagePatterns = {
    "tableFlip": '(╯°□°）╯︵ ┻━┻',
    "tableUnflip": '┬─┬ノ( º _ ºノ)',
    "tableSad": '┻━┻ /(o;︵ o;\\\\\\)'
  };

  // TODO: move to separate file
  var avatars = {
   baggle: 'data:image/png;base64,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',
   beetlejuice: 'data:image/jpeg;base64,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dmVjdG9yRGF0YWJvb2wBAAAAAFBnUHNlbnVtAAAAAFBnUHMAAAAAUGdQQwAAAABMZWZ0VW50RiNSbHQAAAAAAAAAAAAAAABUb3AgVW50RiNSbHQAAAAAAAAAAAAAAABTY2wgVW50RiNQcmNAWQAAAAAAAAAAABBjcm9wV2hlblByaW50aW5nYm9vbAAAAAAOY3JvcFJlY3RCb3R0b21sb25nAAAAAAAAAAxjcm9wUmVjdExlZnRsb25nAAAAAAAAAA1jcm9wUmVjdFJpZ2h0bG9uZwAAAAAAAAALY3JvcFJlY3RUb3Bsb25nAAAAAAA4QklNA+0AAAAAABAASAAAAAEAAQBIAAAAAQABOEJJTQQmAAAAAAAOAAAAAAAAAAAAAD+AAAA4QklNBA0AAAAAAAQAAAAeOEJJTQQZAAAAAAAEAAAAHjhCSU0D8wAAAAAACQAAAAAAAAAAAQA4QklNBAoAAAAAAAEAADhCSU0nEAAAAAAACgABAAAAAAAAAAI4QklNA/UAAAAAAEgAL2ZmAAEAbGZmAAYAAAAAAAEAL2ZmAAEAoZmaAAYAAAAAAAEAMgAAAAEAWgAAAAYAAAAAAAEANQAAAAEALQAAAAYAAAAAAAE4QklNA/gAAAAAAHAAAP////////////////////////////8D6AAAAAD/////////////////////////////A+gAAAAA/////////////////////////////wPoAAAAAP////////////////////////////8D6AAAOEJJTQQIAAAAAAAQAAAAAQAAAkAAAAJAAAAAADhCSU0EHgAAAAAABAAAAAA4QklNBBoAAAAAA1UAAAAGAAAAAAAAAAAAAADIAAAAyAAAABAAYgBlAGUAdABsAGUAagB1AGkAYwBlAC4AagBwAGUAZwAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAyAAAAMgAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAQAAAAAAAG51bGwAAAACAAAABmJvdW5kc09iamMAAAABAAAAAAAAUmN0MQAAAAQAAAAAVG9wIGxvbmcAAAAAAAAAAExlZnRsb25nAAAAAAAAAABCdG9tbG9uZwAAAMgAAAAAUmdodGxvbmcAAADIAAAABnNs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OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOnhtcFJpZ2h0cz0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3JpZ2h0cy8iIHhtcE1NOkRvY3VtZW50SUQ9InV1aWQ6RDc4RUU1RjgzRjNCRTMxMUEyMUZFMjg3MDJFNDE2QzIiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6OTA3MmI2N2MtMTJiZS00MjU0LThiOWQtMGE2Y2IzNjE5MDdlIiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InV1aWQ6RDc4RUU1RjgzRjNCRTMxMUEyMUZFMjg3MDJFNDE2QzIiIHhtcDpDcmVhdGVEYXRlPSIyMDEzLTEwLTIzVDA2OjM0OjI2KzEzOjAwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAxNi0wNS0yNlQyMzoyMDozNS0wNzowMCIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAxNi0wNS0yNlQyMzoyMDozNS0wNzowMCIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgRWxlbWVudHMgNS4wICgyMDA2MDkxNC5yLjc3KSAgV2luZG93cyIgZGM6Zm9ybWF0PSJpbWFnZS9qcGVnIiBwaG90b3Nob3A6TGVnYWN5SVBUQ0RpZ2VzdD0iMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIHBob3Rvc2hvcDpJQ0NQcm9maWxlPSJzUkdCIElFQzYxOTY2LTIuMSIgcGhvdG9zaG9wOkhpc3Rvcnk9IjIwMTYtMDUtMjZUMjM6MjA6MDgtMDc6MDAmI3g5O0ZpbGUgYmVldGxlanVpY2UuanBlZyBvcGVuZWQmI3hBOzIwMTYtMDUtMjZUMjM6MjA6MzUtMDc6MDAmI3g5O0ZpbGUgYmVldGxlanVpY2UuanBlZyBzYXZlZCYjeEE7IiB4bXBSaWdodHM6TWFya2VkPSJGYWxzZSI+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ1dWlkOkQxOEVFNUY4M0YzQkUzMTFBMjFGRTI4NzAyRTQxNkMyIiBzdFJlZjpkb2N1bWVudElEPSJ1dWlkOkQxOEVFNUY4M0YzQkUzMTFBMjFGRTI4NzAyRTQxNkMyIi8+IDx4bXBNTTpIaXN0b3J5PiA8cmRmOlNlcT4gPHJkZjpsaSBzdEV2dDphY3Rpb249InNhdmVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjkwNzJiNjdjLTEyYmUtNDI1NC04YjlkLTBhNmNiMzYxOTA3ZSIgc3RFdnQ6d2hlbj0iMjAxNi0wNS0yNlQyMzoyMDozNS0wNzowMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTUgKE1hY2ludG9zaCkiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg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' 
  };

  var beetlejuiceCount = 0;

  var beetlejuiceMessages = {
    beetlejuice: [
      "I attended Juilliard... I'm a graduate of the Harvard business school. I travel quite extensively. I lived through the Black Plague and had a pretty good time during that. I've seen the EXORCIST ABOUT A HUNDRED AND SIXTY-SEVEN TIMES, AND IT KEEPS GETTING FUNNIER EVERY SINGLE TIME I SEE IT... NOT TO MENTION THE FACT THAT YOU'RE TALKING TO A DEAD GUY... NOW WHAT DO YOU THINK? You think I'm qualified?",
      "I'm feeling a little, ooh, anxious if you know what I mean. It's been about six hundred years after all. I wonder where a guy, an everyday Joe like myself, can find a little *action*.",
      "I'll eat anything you want me to eat. I'll swallow anything you want me to swallow. But, come on down and I'll... chew on a dog! Arroooo!"
    ],
    worried: [
      "Ah. Oh-oh-oh. Ah-ah. Nobody says the 'B' word.",
      "Uh. Hm. Let me stop you right there."
    ],
    banished: [
      'Whoa, hey! What are you doing? Hey, stop it! Hey, you\'re messing up my hair! C\'mon! Whoa! Whoa! Stop it! Whoa!',
      "Hope you like Italian. Hey where are ya going? Ah come on where'd ya go? Come on, you have to work with me here, I'm just trying to cut you a deal. What do ya want me to do? Where are ya? YOU BUNCH OF LOSERS! YOU'RE WORKING WITH A PROFESSIONAL HERE!"
    ],
    done: [
      'Hey, this might be a good look for me.',
      "Don't you hate it when that happens?"
    ]
  };

  var aliases;
  var messagebox;

  var commands = {
    "gif": {
      usage: "<image tags>",
          description: "returns a random gif matching the tags passed",
      process: function(bot, msg, suffix) {
          var tags = suffix.split(" ");
          get_gif(tags, function(id) {
        if (typeof id !== "undefined") {
            bot.sendMessage(msg.channel, "http://media.giphy.com/media/" + id + "/giphy.gif [Tags: " + (tags ? tags : "Random GIF") + "]");
        }
        else {
            bot.sendMessage(msg.channel, "Invalid tags, try something different. [Tags: " + (tags ? tags : "Random GIF") + "]");
        }
          });
      }
    },
      "ping": {
          description: "responds pong, useful for checking if bot is alive",
          process: function(bot, msg, suffix) {
              bot.sendMessage(msg.channel, msg.sender+" pong!");
              if(suffix){
                  bot.sendMessage(msg.channel, "note that !ping takes no arguments!");
              }
          }
      },
      "servers": {
          description: "lists servers bot is connected to",
          process: function(bot,msg){bot.sendMessage(msg.channel,bot.servers);}
      },
      "channels": {
          description: "lists channels bot is connected to",
          process: function(bot,msg) { 
            bot.sendMessage(msg.channel,bot.channels); 
          }
      },
      "myid": {
          description: "returns the user id of the sender",
          process: function(bot,msg){bot.sendMessage(msg.channel,msg.author.id);}
      },
      "idle": {
          description: "sets bot status to idle",
          process: function(bot,msg){ bot.setStatusIdle();}
      },
      "online": {
          description: "sets bot status to online",
          process: function(bot,msg){ bot.setStatusOnline();}
      },
      "youtube": {
          usage: "<video tags>",
          description: "gets youtube video matching tags",
          process: function(bot,msg,suffix){
              youtube_plugin.respond(suffix,msg.channel,bot);
          }
      },
      "say": {
          usage: "<message>",
          description: "bot says message",
          process: function(bot,msg,suffix){
            bot.sendMessage(msg.channel,suffix);
          }
      },
      "puppet": {
        usage: "<channel message>",
        description: "bot repeats message in the specified channel",     
        process: function(bot,msg,suffix) { 
          var args = suffix.split(' ');
          var channelNameOrId = args.shift();
          var message = args.join(' ');

          var channel = findChannel(bot, msg, channelNameOrId);

          if (channel) {
            bot.sendMessage(channel, message);
          }
        }
      },
    "announce": {
          usage: "<message>",
          description: "bot says message with text to speech",
          process: function(bot,msg,suffix){ bot.sendMessage(msg.channel,suffix,{tts:true});}
      },
      "pullanddeploy": {
          description: "bot will perform a git pull master and restart with the new code",
          process: function(bot,msg,suffix) {
              bot.sendMessage(msg.channel,"fetching updates...",function(error,sentMsg){
                  console.log("updating...");
                var spawn = require('child_process').spawn;
                  var log = function(err,stdout,stderr){
                      if(stdout){console.log(stdout);}
                      if(stderr){console.log(stderr);}
                  };
                  var fetch = spawn('git', ['fetch']);
                  fetch.stdout.on('data',function(data){
                      console.log(data.toString());
                  });
                  fetch.on("close",function(code){
                      var reset = spawn('git', ['reset','--hard','origin/master']);
                      reset.stdout.on('data',function(data){
                          console.log(data.toString());
                      });
                      reset.on("close",function(code){
                          var npm = spawn('npm', ['install']);
                          npm.stdout.on('data',function(data){
                              console.log(data.toString());
                          });
                          npm.on("close",function(code){
                              console.log("goodbye");
                              bot.sendMessage(msg.channel,"brb!",function(){
                                  bot.logout(function(){
                                      process.exit();
                                  });
                              });
                          });
                      });
                  });
              });
          }
      },
      "meme": {
          usage: 'meme "top text" "bottom text"',
          process: function(bot,msg,suffix) {
              var tags = msg.content.split('"');
              var memetype = tags[0].split(" ")[1];
              //bot.sendMessage(msg.channel,tags);
              var Imgflipper = require("imgflipper");
              var imgflipper = new Imgflipper(AuthDetails.imgflip_username, AuthDetails.imgflip_password);
              imgflipper.generateMeme(meme[memetype], tags[1]?tags[1]:"", tags[3]?tags[3]:"", function(err, image){
                  //console.log(arguments);
                  bot.sendMessage(msg.channel,image);
              });
          }
      },
      "memehelp": { //TODO: this should be handled by !help
          description: "returns available memes for !meme",
          process: function(bot,msg) {
              var str = "Currently available memes:\n"
              for (var m in meme){
                  str += m + "\n"
              }
              bot.sendMessage(msg.channel,str);
          }
      },
      "version": {
          description: "returns the git commit this bot is running",
          process: function(bot,msg,suffix) {
              var commit = require('child_process').spawn('git', ['log','-n','1']);
              commit.stdout.on('data', function(data) {
                  bot.sendMessage(msg.channel,data);
              });
              commit.on('close',function(code) {
                  if( code != 0){
                      bot.sendMessage(msg.channel,"failed checking git version!");
                  }
              });
          }
      },
      "log": {
          usage: "<log message>",
          description: "logs message to bot console",
          process: function(bot,msg,suffix){console.log(msg.content);}
      },
      "wiki": {
          usage: "<search terms>",
          description: "returns the summary of the first matching search result from Wikipedia",
          process: function(bot,msg,suffix) {
              var query = suffix;
              if(!query) {
                  bot.sendMessage(msg.channel,"usage: !wiki search terms");
                  return;
              }
              var Wiki = require('wikijs');
              new Wiki().search(query,1).then(function(data) {
                  new Wiki().page(data.results[0]).then(function(page) {
                      page.summary().then(function(summary) {
                          var sumText = summary.toString().split('\n');
                          var continuation = function() {
                              var paragraph = sumText.shift();
                              if(paragraph){
                                  bot.sendMessage(msg.channel,paragraph,continuation);
                              }
                          };
                          continuation();
                      });
                  });
              },function(err){
                  bot.sendMessage(msg.channel,err);
              });
          }
      },
      "join-server": {
          usage: "<invite>",
          description: "joins the server it's invited to",
          process: function(bot,msg,suffix) {
              console.log(bot.joinServer(suffix,function(error,server) {
                  console.log("callback: " + arguments);
                  if(error){
                      bot.sendMessage(msg.channel,"failed to join: " + error);
                  } else {
                      console.log("Joined server " + server);
                      bot.sendMessage(msg.channel,"Successfully joined " + server);
                  }
              }));
          }
      },
      "create": {
          usage: "<channel name>",
          description: "creates a new text channel with the given name.",
          process: function(bot,msg,suffix) {
              console.log('message: ' + msg);
              bot.createChannel(msg.channel.server,suffix,"text").then(function(channel) {
                  bot.sendMessage(msg.channel,"created " + channel);
              }).catch(function(error){
          bot.sendMessage(msg.channel,"failed to create channel: " + error);
        });
          }
      },
    "voice": {
      usage: "<channel name>",
      description: "creates a new voice channel with the give name.",
      process: function(bot,msg,suffix) {
              bot.createChannel(msg.channel.server,suffix,"voice").then(function(channel) {
                  bot.sendMessage(msg.channel,"created " + channel.id);
          console.log("created " + channel);
              }).catch(function(error){
          bot.sendMessage(msg.channel,"failed to create channel: " + error);
        });
          }
    },
      "delete": {
          usage: "<channel name>",
          description: "deletes the specified channel",
          process: function(bot, msg, suffix) {
            var channel = findChannel(bot, msg, suffix);
            if (!channel) { return; }
              bot.sendMessage(msg.channel.server.defaultChannel, "deleting channel " + suffix + " at " +msg.author + "'s request");
              if(msg.channel.server.defaultChannel != msg.channel){
                  bot.sendMessage(msg.channel,"deleting " + channel);
              }
              bot.deleteChannel(channel).then(function(channel) {
                console.log("deleted " + suffix + " at " + msg.author + "'s request");
              }).catch(function(error) {
                bot.sendMessage(msg.channel, "couldn't delete channel: " + error);
             });
          }
      },
      "avatar": {
        usage: "<avatar URL to set>",
        process: function(bot, msg, suffix) {
          var avatar = avatars[suffix];
          try{
            if (avatar) {
              console.log("Setting avatar to " + suffix);
              bot.setAvatar(avatar);
            } else {
              bot.sendMessage(msg.channel, 'Avatar \'' + suffix + '\' not recognized.');
            }

        
          } catch(e){
            bot.sendMessage(msg.channel,
              "Couldn't set avatar from " + url + ". Error: " + e.stack);
          }
        }
      },
      "changename": {
        usage: "<avatar URL to set>",
        process: function(bot, msg, suffix) {
          var username = suffix;
          try{
            console.log("Setting username to " + username);
            // TODO: validate URL
            var result = bot.setUsername(username);
          } catch(e){
            bot.sendMessage(msg.channel,
              "Couldn't set username to " + username + ". Error: " + e.stack);
          }
        }
      },

      "stock": {
          usage: "<stock to fetch>",
          process: function(bot,msg,suffix) {
              var yahooFinance = require('yahoo-finance');
              yahooFinance.snapshot({
                symbol: suffix,
                fields: ['s', 'n', 'd1', 'l1', 'y', 'r'],
              }, function (error, snapshot) {
                  if(error){
                      bot.sendMessage(msg.channel,"couldn't get stock: " + error);
                  } else {
                      //bot.sendMessage(msg.channel,JSON.stringify(snapshot));
                      bot.sendMessage(msg.channel,snapshot.name
                          + "\nprice: $" + snapshot.lastTradePriceOnly);
                  }  
              });
          }
      },
    "wolfram": {
      usage: "<search terms>",
          description: "gives results from wolframalpha using search terms",
          process: function(bot,msg,suffix){
          if(!suffix){
            bot.sendMessage(msg.channel,"Usage: !wolfram <search terms> (Ex. !wolfram integrate 4x)");
          }
                wolfram_plugin.respond(suffix,msg.channel,bot);
              }
    },
      "rss": {
          description: "lists available rss feeds",
          process: function(bot,msg,suffix) {
              /*var args = suffix.split(" ");
              var count = args.shift();
              var url = args.join(" ");
              rssfeed(bot,msg,url,count,full);*/
              bot.sendMessage(msg.channel,"Available feeds:", function(){
                  for(var c in rssFeeds){
                      bot.sendMessage(msg.channel,c + ": " + rssFeeds[c].url);
                  }
              });
          }
      },
      "reddit": {
          usage: "[subreddit]",
          description: "Returns the top post on reddit. Can optionally pass a subreddit to get the top psot there instead",
          process: function(bot,msg,suffix) {
              var path = "/.rss"
              if(suffix){
                  path = "/r/"+suffix+path;
              }
              rssfeed(bot,msg,"https://www.reddit.com"+path,1,false);
          }
      },
    "alias": {
      usage: "<name> <actual command>",
      description: "Creates command aliases. Useful for making simple commands on the fly",
      process: function(bot,msg,suffix) {
        var args = suffix.split(" ");
        var name = args.shift();
        if(!name){
          bot.sendMessage(msg.channel,"!alias " + this.usage + "\n" + this.description);
        } else if(commands[name] || name === "help"){
          bot.sendMessage(msg.channel,"overwriting commands with aliases is not allowed!");
        } else {
          var command = args.shift();
          aliases[name] = [command, args.join(" ")];
          //now save the new alias
          require("fs").writeFile("./alias.json",JSON.stringify(aliases,null,2), null);
          bot.sendMessage(msg.channel,"created alias " + name);
        }
      }
    },
    "userid": {
      usage: "[user to get id of]",
      description: "Returns the unique id of a user. This is useful for permissions.",
      process: function(bot,msg,suffix) {
        if(suffix){
          var users = msg.channel.server.members.getAll("username",suffix);
          if(users.length == 1){
            bot.sendMessage(msg.channel, "The id of " + users[0] + " is " + users[0].id)
          } else if(users.length > 1){
            var response = "multiple users found:";
            for(var i=0;i<users.length;i++){
              var user = users[i];
              response += "\nThe id of " + user + " is " + user.id;
            }
            bot.sendMessage(msg.channel,response);
          } else {
            bot.sendMessage(msg.channel,"No user " + suffix + " found!");
          }
        } else {
          bot.sendMessage(msg.channel, "The id of " + msg.author + " is " + msg.author.id);
        }
      }
    },
    "eval": {
      usage: "<command>",
      description: 'Executes arbitrary javascript in the bot process. User must have "eval" permission',
      process: function(bot,msg,suffix) {
        if(Permissions.checkPermission(msg.author,"eval")){
          bot.sendMessage(msg.channel, eval(suffix,bot));
        } else {
          bot.sendMessage(msg.channel, msg.author + " doesn't have permission to execute eval!");
        }
      }
    },
    "topic": {
      usage: "[topic]",
      description: 'Sets the topic for the channel. No topic removes the topic.',
      process: function(bot,msg,suffix) {
        bot.setChannelTopic(msg.channel,suffix);
      }
    },
    "testroll": {
      usage: "[# of sides] or [# of dice]d[# of sides]( + [# of dice]d[# of sides] + ...)",
      description: "roll one die with x sides, or multiple dice using d20 syntax. Default value is 10",
      process: function(bot,msg,suffix) {
        if (suffix.split("d").length <= 1) {
          var numSides = suffix || 10;
          var roll = d20.verboseRoll(numSides);
          bot.sendMessage(msg.channel, msg.author + " rolled '" + suffix + "' for " + roll, () => {
            setTimeout(function() {
              globals.chatData.dieRolls.handleDieRolls(roll, numSides, msg.channel, msg.author.id);  
            }, 3000);
          });
        }  
        else {
          var match = suffix.match(/^\s*(\d+)?d(\d+)\s*/);
          if (match) {
            var numDice = match[1] ? match[1] : 1;
            var numSides = match[2];
         
            var rolls = d20.verboseRoll(suffix);
            bot.sendMessage(msg.channel, ":game_die: " + msg.author + " rolled '" + match[0] + "' for " + rolls, () => {
              if (rolls && rolls.length > 0)
              setTimeout(function() {
                globals.chatData.dieRolls.handleDieRolls(rolls, numSides, msg.channel, msg.author.id);  
              }, 3000);
            });
          } else {
            bot.sendMessage(msg.channel, msg.author + " :game_die: invalid die roll specified! :game_die:");
          }
        }
      }
    },
    "testUserId": {
      usage: "<userid>",
      description: "debugging ability to get user object from userid",
      process: function(bot, msg, suffix) {
        console.log('Called testUserId with "' + suffix + '"');
        var userId = suffix;
        console.log('msg: ' + msg);
        console.log('msg.channel: ' + msg.channel);
        console.log('msg.channel.server: ' + msg.channel.server);
        console.log('msg.channel.server.members: ' + msg.channel.server.members);
        try {
         var user = msg.channel.server.members.get("id", userId);
        } catch (e) { console.log(e)};
        bot.sendMessage(msg.channel, 'Oh, ' + user + '. That guy\'s a jerk.');
      }
    },
    "rollstats": {
      usage: "[user]",
      description: "show statistics about recorded die rolls",
      permissions: ['all'],
      process: function(bot, msg, suffix) {
        if (!globals.db.mongo.hasOpenConnection) {
          console.log('No open mongodb connection. Rollstats not enabled.');
          return;
        }

        var getNormalizedDateString = function(date) {
          return date.toLocaleDateString('fullwide', { month: 'long', day: 'numeric', year: (date.getFullYear() === (new Date().getFullYear()) ? undefined : 'numeric') } );
        };

        // test with no roll data (and w/ no roll data for specificied size; pass in a bogus size)
        var aggregateRollStats = function(table, size) {                
          var aggregate = table.reduce((aggregate, current) => {
            if (aggregate.lowest === undefined || current.value < aggregate.lowest.value) {
              aggregate.lowest = current;
            }
            if (aggregate.highest === undefined || current.value > aggregate.highest.value) {
              aggregate.highest = current;
            }

            if (aggregate.oldest === undefined || current.time < aggregate.oldest.time) {
              aggregate.oldest = current;
            }

            if (aggregate.userRolls[current.user] === undefined) {
              aggregate.userRolls[current.user] = [];
            }

            aggregate.userRolls[current.user].push(current);
            return aggregate;
          }, { oldest: undefined, lowest: undefined, highest: undefined, userRolls: {} });

          var userStats = Object.keys(aggregate.userRolls).reduce((userAggregate, user) => {
            var rolls = aggregate.userRolls[user];
            var averageRoll = rolls.reduce((total, roll) => total + roll.value, 0) / rolls.length;

            if (userAggregate.mostRolls === undefined || rolls.length > userAggregate.mostRolls) {
              userAggregate.mostRolls = { user: user, value: rolls.length };
            }
            if (userAggregate.lowestAverage === undefined || averageRoll < userAggregate.lowestAverage) {
              userAggregate.lowestAverage = { user: user, value: averageRoll };
            }
            if (userAggregate.highestAverage === undefined || averageRoll > userAggregate.highestAverage) {
              userAggregate.highestAverage = { user: user, value: averageRoll };
            }
            if (userAggregate.averageAverage === undefined || Math.abs(size/2 - averageRoll) < Math.abs(size/2 - userAggregate.averageAverage)) {
              userAggregate.averageAverage = { user: user, value: averageRoll };
            }                  
            return userAggregate;
          }, { mostRolls: undefined, lowestAverage: undefined, highestAverage: undefined, averageAverage: undefined });
          return {
            oldest: aggregate.oldest,
            lowest: aggregate.lowest,
            highest: aggregate.highest,
            mostRolls: userStats.mostRolls,
            lowestAverage: userStats.lowestAverage,
            highestAverage: userStats.highestAverage,
            averageAverage: userStats.averageAverage
          };
        };   
          
        var getUser = function(userId) {
          var user = msg.channel.server.members.get('id', userId);
          return user ? user : '**unknown user**';
        }

        globals.db.mongo.dumpTable(globals.config.dieroll.mongo.collection)  
          .then(rolls => {
            Object.keys(globals.chatData.dieRolls).forEach(size => {
              if (isNaN(parseInt(size))) { return; } // TODO: put dieRoll records in a child property

              log.debug('Calculating roll data for d' + size);            

              // var userStats = aggregateRollStats(rolls, size);
              // var lowRoll = globals.chatData.dieRolls.getLowRoll(rolls, size);
              // var highRoll = globals.chatData.dieRolls.getHighRoll(rolls, size);
              var stats = aggregateRollStats(rolls.filter(roll => roll.sides == size), size);

              //TODO: handle user-not-found case

              var statsMsg = '🎲 Stats for all **d' + size + '** die rolls recorded since ' + getNormalizedDateString(new Date(stats.oldest.time)) + ' 🎲';
              statsMsg += '\n\n • ';
              statsMsg += 'Lowest roll on record is **' + stats.lowest.value + '**, by ' + getUser(stats.lowest.user) + ' on ' + getNormalizedDateString(new Date(stats.lowest.time));
              statsMsg += '\n\n • ';
              statsMsg += 'Highest roll on record is **' + stats.highest.value + '**, by ' + getUser(stats.highest.user) + ' on ' + getNormalizedDateString(new Date(stats.highest.time));
              statsMsg += '\n\n • ';
              statsMsg += 'Most rolls recorded is **' + stats.mostRolls.value + '**, for ' + getUser(stats.mostRolls.user);
              statsMsg += '\n\n • ';
              statsMsg += 'Lowest average roll on record is **' + Math.round(stats.lowestAverage.value) + '**, for ' + getUser(stats.lowestAverage.user);
              statsMsg += '\n\n • ';
              statsMsg += 'Highest average roll on record is **' + Math.round(stats.highestAverage.value) + '**, for ' + getUser(stats.highestAverage.user);
              statsMsg += '\n\n • ';
              statsMsg += 'Most average average roll on record is **' + Math.round(stats.averageAverage.value) + '**, for ' + getUser('id', stats.averageAverage.user);

              bot.sendMessage(msg.channel, statsMsg);                  
            });
          });

        //for each die size, getRollStats(size) => stats object
        // --- if no user found for an userid in db, attribute  'an unrecognized user'
        // var user = 
        /*
          TODO:
          * Show which die size are being tracked
          * Date of initial record ("tracked since...")
          * Number of total rolls
          * High & low rolls, with date and user
          * Top N users w/ number of rolls
          * User with highest/lowest/"averagist" average roll
          * - if total users is M < N, show top M instead
          * if [user] specified, show stats for specific user (high/low, number of rolls)
        */
      }
    },
    "msg": {
      usage: "<user> <message to leave user>",
      description: "leaves a message for a user the next time they come online",
      process: function(bot,msg,suffix) {
        var args = suffix.split(' ');
        var user = args.shift();
        var message = args.join(' ');
        if(user.startsWith('<@')){
          user = user.substr(2,user.length-3);
        }
        var target = msg.channel.server.members.get("id",user);
        if(!target){
          target = msg.channel.server.members.get("username",user);
        }
        messagebox[target.id] = {
          channel: msg.channel.id,
          content: target + ", " + msg.author + " said: " + message
        };
        updateMessagebox();
        bot.sendMessage(msg.channel,"message saved.")
      }
    },
    "twitch": {
      usage: "<stream>",
      description: "checks if the given stream is online",
      process: function(bot,msg,suffix){
        require("request")("https://api.twitch.tv/kraken/streams/"+suffix,
        function(err,res,body){
          var stream = JSON.parse(body);
          if(stream.stream){
            bot.sendMessage(msg.channel, suffix
              +" is online, playing "
              +stream.stream.game
              +"\n"+stream.stream.channel.status
              +"\n"+stream.stream.preview.large)
          }else{
            bot.sendMessage(msg.channel, suffix+" is offline")
          }
        });
      }
    },
    "xkcd": {
      usage: "[comic number]",
      description: "displays a given xkcd comic number (or the latest if nothing specified",
      process: function(bot,msg,suffix){
        var url = "http://xkcd.com/";
        if(suffix != "") url += suffix+"/";
        url += "info.0.json";
        require("request")(url,function(err,res,body){
          try{
            var comic = JSON.parse(body);
            bot.sendMessage(msg.channel,
              comic.title+"\n"+comic.img,function(){
                bot.sendMessage(msg.channel,comic.alt)
            });
          }catch(e){
            bot.sendMessage(msg.channel,
              "Couldn't fetch an XKCD for "+suffix);
          }
        });
      }
    },
      "watchtogether": {
          usage: "[video url (Youtube, Vimeo)",
          description: "Generate a watch2gether room with your video to watch with your little friends!",
          process: function(bot,msg,suffix){
              var watch2getherUrl = "https://www.watch2gether.com/go#";
              bot.sendMessage(msg.channel,
                  "watch2gether link",function(){
                      bot.sendMessage(msg.channel,watch2getherUrl + suffix)
                  })
          }
      },
      "uptime": {
        usage: "",
    description: "returns the amount of time since the bot started",
    process: function(bot,msg,suffix){
      var now = Date.now();
      var msec = now - startTime;
      console.log("Uptime is " + msec + " milliseconds");
      var days = Math.floor(msec / 1000 / 60 / 60 / 24);
      msec -= days * 1000 * 60 * 60 * 24;
      var hours = Math.floor(msec / 1000 / 60 / 60);
      msec -= hours * 1000 * 60 * 60;
      var mins = Math.floor(msec / 1000 / 60);
      msec -= mins * 1000 * 60;
      var secs = Math.floor(msec / 1000);
      var timestr = "";
      if(days > 0) {
        timestr += days + " days ";
      }
      if(hours > 0) {
        timestr += hours + " hours ";
      }
      if(mins > 0) {
        timestr += mins + " minutes ";
      }
      if(secs > 0) {
        timestr += secs + " seconds ";
      }
      bot.sendMessage(msg.channel,"Uptime: " + timestr);
    }
      }
  };
  try{
  var rssFeeds = undefined; //require("./rss.json");
  function loadFeeds(){
      for(var cmd in rssFeeds){
          commands[cmd] = {
              usage: "[count]",
              description: rssFeeds[cmd].description,
              url: rssFeeds[cmd].url,
              process: function(bot,msg,suffix){
                  var count = 1;
                  if(suffix != null && suffix != "" && !isNaN(suffix)){
                      count = suffix;
                  }
                  rssfeed(bot,msg,this.url,count,false);
              }
          };
      }
  }
  } catch(e) {
      console.log("Couldn't load rss.json. See rss.json.example if you want rss feed commands. error: " + e);
  }

  try{
    aliases = require("alias.json");
  } catch(e) {
    //No aliases defined
    aliases = {};
  }

  try{
    messagebox = require("messagebox.json");
  } catch(e) {
    //no stored messages
    messagebox = {};
  }
  function updateMessagebox(){
    require("fs").writeFile("./messagebox.json",JSON.stringify(messagebox,null,2), null);
  }

  function rssfeed(bot,msg,url,count,full){
      var FeedParser = require('feedparser');
      var feedparser = new FeedParser();
      var request = require('request');
      request(url).pipe(feedparser);
      feedparser.on('error', function(error){
          bot.sendMessage(msg.channel,"failed reading feed: " + error);
      });
      var shown = 0;
      feedparser.on('readable',function() {
          var stream = this;
          shown += 1
          if(shown > count){
              return;
          }
          var item = stream.read();
          bot.sendMessage(msg.channel,item.title + " - " + item.link, function() {
              if(full === true){
                  var text = htmlToText.fromString(item.description,{
                      wordwrap:false,
                      ignoreHref:true
                  });
                  bot.sendMessage(msg.channel,text);
              }
          });
          stream.alreadyRead = true;
      });
  }


  var bot = new Discord.Client();

  bot.on("ready", function () {
    loadFeeds();
    console.log("Ready to begin! Serving in " + bot.channels.length + " channels");
    require("./plugins.js").init();
  });

  bot.on("disconnected", function () {
    console.log("Disconnected from server.");
    process.exit(1); //exit node.js with an error
  });

  bot.on("message", function (msg) {
    //check if message is a command
    if(msg.author.id != bot.user.id && (msg.content[0] === '!' || msg.content.indexOf(bot.user.mention()) == 0)){
          console.log("treating " + msg.content + " from " + msg.author + " as command");
      var cmdTxt = msg.content.split(" ")[0].substring(1);
          var suffix = msg.content.substring(cmdTxt.length+2);//add one for the ! and one for the space
          if(msg.content.indexOf(bot.user.mention()) == 0){
        try {
          cmdTxt = msg.content.split(" ")[1];
          suffix = msg.content.substring(bot.user.mention().length+cmdTxt.length+2);
        } catch(e){ //no command
          bot.sendMessage(msg.channel,"Yes?");
          return;
        }
          }
      alias = aliases[cmdTxt];
      if(alias){
        console.log(cmdTxt + " is an alias, constructed command is " + alias.join(" ") + " " + suffix);
        cmdTxt = alias[0];
        suffix = alias[1] + " " + suffix;
      }
      var cmd = commands[cmdTxt];
          if(cmdTxt === "help"){
              //help is special since it iterates over the other commands
        bot.sendMessage(msg.author,"Available Commands:", function(){
          for(var cmd in commands) {
            var info = "!" + cmd;
            var usage = commands[cmd].usage;
            if(usage){
              info += " " + usage;
            }
            var description = commands[cmd].description;
            if(description){
              info += "\n\t" + description;
            }
            bot.sendMessage(msg.author,info);
          }
        });
          }
      else if(cmd) {
        //TODO: proper declarative permissions
        if(cmd.permissions && cmd.permissions.indexOf('all') !== -1 || Permissions.checkPermission(msg.author,"basic")) {
          try{
            cmd.process(bot,msg,suffix);
          } catch(e){
            if(Config.debug){
              bot.sendMessage(msg.channel, "command " + cmdTxt + " failed :(\n" + e.stack);
            }
          }
        } else {
          if(Config.respondToInvalid){
            bot.sendMessage(msg.channel, "Invalid command " + cmdTxt);
          }
        }
      }
    } else if (msg.author.id != bot.user.id && msg.content.indexOf(messagePatterns.tableFlip) !== -1) {
      var responses = [
       'You seemed to have flipped your table! Let me fix that for you.\n' + messagePatterns.tableUnflip,
       messagePatterns.tableSad + ' your table...'
      ];
      bot.sendMessage(msg.channel, randomElement(responses));
    } else if (msg.author.id != bot.user.id && msg.content.indexOf(messagePatterns.tableUnflip) !== -1) {
      bot.sendMessage(msg.channel, 'F this table! ' + messagePatterns.tableFlip);
    } else {
      //message isn't a command or is from us
          //drop our own messages to prevent feedback loops
          if(msg.author == bot.user){
              return;
          }
          
          if (msg.author != bot.user && msg.isMentioned(bot.user)) {
                  bot.sendMessage(msg.channel,msg.author + ", you called?");
          }
      }

    if (msg.author.id != bot.user.id && msg.content.toLowerCase().indexOf('beetlejuice') !== -1) {
      var numNewBeetlejuices = countOccurrences(msg.content.toLowerCase(), 'beetlejuice');
      numNewBeetlejuices = Math.min(numNewBeetlejuices, 3 - beetlejuiceCount%3);
      beetlejuiceCount = (beetlejuiceCount + numNewBeetlejuices) % 6;

      console.log('Beetlejuice count: ' + beetlejuiceCount);

      if (beetlejuiceCount === 3) {
        var avatar = avatars[suffix];
        bot.setAvatar(avatars.beetlejuice, function() {
          bot.sendMessage(msg.channel,
            randomElement(beetlejuiceMessages.beetlejuice));
        });
      } else if (beetlejuiceCount === 5) {
        bot.sendMessage(msg.channel, randomElement(beetlejuiceMessages.worried));
      } else if (beetlejuiceCount === 0) {
        var avatar = avatars[suffix];
          bot.sendMessage(msg.channel, randomElement(beetlejuiceMessages.banished), function() {
            bot.setAvatar(avatars.baggle, function() {
              bot.sendMessage(msg.channel, '!say :coffin: :skull: :coffin: :skull: :coffin: :skull: :coffin:', function() {
              setTimeout(function() {
                bot.sendMessage(msg.channel, randomElement(beetlejuiceMessages.done));
              }, 2000);
            });
          });
        });
      }
    } 

    if (msg.author.id != bot.user.id && globals.config.dieroll.users.approved.map(user => user.id).indexOf(msg.author.id) !== -1 
      && msg.content.toLowerCase().match(/<@\d+> rolled '\d+d\d+'/)) {
        var match = msg.content.toLowerCase().match(/<@\d+> rolled '(\d+)d(\d+)' for ((\d+,?)+)/);
        if (match) {
          var numDice = parseInt(match[1]);
          var sides = parseInt(match[2]);
          var results = match[3].split(',').map(result => parseInt(result));

          if (numDice !== results.length) {
            log.warn('Roll message had mismatched number of dice. reported # of dice: ' + sides + '; actual # of sides: ' + results.length + '; full message: ' + msg.content);
          } else {
            globals.chatData.dieRolls.handleDieRolls(results, sides, msg.channel, msg.author.id);
          }
        }
    }
  });
   

  //Log user status changes
  bot.on("presence", function(user,status,gameId) {
    //if(status === "online"){
    //console.log("presence update");
    console.log(user+" went "+status);
    //}
    try{
    if(status != 'offline'){
      if(messagebox.hasOwnProperty(user.id)){
        console.log("found message for " + user.id);
        var message = messagebox[user.id];
        var channel = bot.channels.get("id",message.channel);
        delete messagebox[user.id];
        updateMessagebox();
        bot.sendMessage(channel,message.content);
      }
    }
    }catch(e){}
  });

  function randomElement(_array) {
    return _array[Math.floor(Math.random()*_array.length)]
  }

  function countOccurrences(str, substr) {
    var occurrences = 0;
    if (str && str.length > 0 && substr && substr.length > 0 && substr.length <= str.length) {
       while (str && str.indexOf(substr) !== -1) {
          occurrences++;
          str = str.substr(str.indexOf(substr) + substr.length);
       }
    }
    return occurrences;
  }

  function getChannels(bot, nameOrId) {
    var channels = []; 

    var channel = bot.channels.get("id", nameOrId);
    if(nameOrId.startsWith('<#')){
      channel = bot.channels.get("id",nameOrId.substr(2,nameOrId.length-3));
    }
    if (channel) {
      channels.push(channel);
    }

    if(channels.length === 0){
      channels = bot.channels.getAll("name",nameOrId) || [];
    }
    return channels;
  }

  function findChannel(bot, msg, nameOrId) {
    var channels = getChannels(bot, nameOrId);
    if (channels.length === 0) {
      bot.sendMessage(msg.channel, "Couldn't find channel " + nameOrId + " to delete!");
      return;
    } else if (channels.length > 1) {
      var response = "Multiple channels match, please use id:";
      for(var i = 0; i < channels.length ;i++) {
        response += channels[i] + ": " + channels[i].id;
      }
      bot.sendMessage(msg.channel,response);
      return;            
    }
    return channels[0];
  }

  function get_gif(tags, func) {
          //limit=1 will only return 1 gif
          var params = {
              "api_key": giphy_config.api_key,
              "rating": giphy_config.rating,
              "format": "json",
              "limit": 1
          };
          var query = qs.stringify(params);

          if (tags !== null) {
              query += "&tag=" + tags.join('+')
          }

          //wouldnt see request lib if defined at the top for some reason:\
          var request = require("request");
          //console.log(query)
          request(giphy_config.url + "?" + query, function (error, response, body) {
              //console.log(arguments)
              if (error || response.statusCode !== 200) {
                  console.error("giphy: Got error: " + body);
                  console.log(error);
                  //console.log(response)
              }
              else {
                  try{
                      var responseObj = JSON.parse(body)
                      func(responseObj.data.id);
                  }
                  catch(err){
                      func(undefined);
                  }
              }
          }.bind(this));
      }
  exports.addCommand = function(commandName, commandObject){
      try {
          commands[commandName] = commandObject;
      } catch(err){
          console.log(err);
      }
  }
  exports.commandCount = function(){
      return Object.keys(commands).length;
  }
  console.log('Logging in with credientials: username: ' + AuthDetails.email + '; password: ' + AuthDetails.password.replace(/./g, '*'));
  bot.login(AuthDetails.email, AuthDetails.password);
});

function loadConfig(configName) {
  var configPath = './config/';
  var overridePath = configPath + 'overrides/';
  var _config = configPath + configName + '.json';
  var _override = overridePath + configName + '.json';

  if (globals.config.hasOwnProperty(configName)) {
    return Promise.resolve(config[configName]);
  }

  return utils.readFile(_override)
    .then(undefined, () => utils.readFile(_config))
    .then(data => {  globals.config[configName] = data; }, function(e) {});
}