const args = require('yargs')
    .scriptName("sqlcli")
    .showHelpOnFail(true)
    .command("$0", "Create an SQL CLI that is disconnected to begin with", (y) => {
        y.options({
            "username": {
                alias: ["user", "u"],
                string: true,
            },
            "password": {
                alias: ["pass", "p"],
                string: true,
            },
            "host": {
                alias: ["h"],
                string: true,
            },
            "port": {
                number: true,
                default: 3306
            },
            "database": {
                alias: ["db"],
                string: true,
            },
            "driver": {
                string: true,
                default: "mysql"
            }
        });
    })
    .command("<uri>", "Connect to a DB using a URI", (y) => {
        y.positional("uri", {
            desc: "URI to a DB server to connect to",
            type: "string",
            conflicts: ["username", "password", "host", "port", "database"]
        });
    });

const rl = require("readline");
const vm = require("vm"); // TODO: Create a VM and update the context to have latest responses
const $ = [];
const $s = [];
const vmContext = vm.createContext();
Object.defineProperties(vmContext, {
    $: {
        get: () => Array.from($)
    },
    $0: {
        get: () => Object.values(Object.assign({}, Array.from($)[0]))
    },
    $s: {
        get: () => Array.from($s)
    },
    $s0: {
        get: () => Object.values(Object.assign({}, Array.from($s)[0]))
    },
});
const mysql = require("mysql2/promise");
const chalk = require("chalk");
const url = require("url");
const yargs = require('yargs');
const rawModes = {
    "all": 0b11,
    "schema": 0b10,
    "values": 0b01,
};

let db = null;
let repl = null;

let config = {
    host: null,
    port: null,
    user: null,
    password: null,
    database: null,
};
let settings = {
    prompt: "mysql",
    raw: {
        active: false,
        mode: rawModes.values,
        getMode: (v) => Object.keys(rawModes).find(e => rawModes[e] == (v || settings.raw.mode))
    },
    nestTables: null
};

let lastRetCode = 0;

function log(obj) {
    process.stdout.write(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

function logn(obj) {
    log(obj);
    log("\n");
}

function logerr(err) {
    if (err instanceof Error) {
        err = {
            name: err.name,
            errno: err.code || -1,
            message: err.message,
            stack: err.stack || "no stack"
        };
    }
    process.stderr.write(typeof err === "string" ? err : JSON.stringify(err, null, 2).replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));
    process.stderr.write("\n");
}

async function processArgs() {
    let args = yargs.argv;
    config.uri = args._[0] || null;
    config.host = args.host || config.host;
    config.port = args.port || config.port;
    config.user = args.username || config.user;
    config.password = args.password || config.password;
    config.database = args.database || config.database;

    try {
        if (config.uri) {
            let obj = url.parse(config.uri);
            if (!obj.protocol.startsWith("mysql")) throw {
                message: "Bad MySQL URI. Protocol must be 'mysql://'.",
                code: "BADURI",
                errno: 11
            };
            config.host = obj.hostname;
            config.port = obj.port;
            [config.user, config.password] = obj.auth.split(":");
            config.database = obj.pathname.substr(1);
        }

        if (config.uri || config.host) await (db = mysql.createConnection(config.uri || config));
    } catch (err) {
        logerr(err);
        db = null;
    }
}

async function handleCommand(data) {
    if (data.startsWith(">")) {
        // do it in a different repl
        return handleJsInstruction(data.substring(1));
    } else if (data.startsWith("/")) {
        // set it with a setting
        return handleAppCommand(data.substring(1));
    } else {
        // execute on the server
        if (db === null) throw {
            message: "DB not connected.",
            code: "DBDISCON",
            errno: 12
        };

        let suppress = data.endsWith("sh");
        if (suppress) data = data.substring(0, data.length - 2);

        let r = await (await db).query({
            sql: data,
            nestTables: settings.nestTables
        });
        $.splice(0, 0, r[0]);
        $s.splice(0, 0, r[1]);

        if (settings.raw.active && !suppress) return settings.raw.mode == rawModes.all ? r : settings.raw.mode == rawModes.schema ? r[1] : r[0];
        else if (!suppress) return r[1] != null ? handleSQLResponse(r[0]) : handleSQLModify(r[0]);
        else return null;
    }
}

function handleJsInstruction(inst) {
    // logn(chalk.italic.blue("JS VM coming soon..."));
    try {
        let ret = vm.runInContext(inst, vmContext, {
            displayErrors: true,
            breakOnSigint: true,
        });
        return ret;
    } catch (err) {
        logerr(err);
    }
}

const appCommands = {
    "_": {
        "prompt": [],
    },
    prompt(...p) {
        if (p.length == 0 || p.join("").trim() == "") return `Current Prompt: ${settings.prompt}`;

        if (p[0].toLowerCase() == "$reset") setDefaultPrompt();
        else {
            for (let c in config) p = p.map(v => v.replace(new RegExp("\\$" + c, "gi"), config[c])); //jshint ignore:line
            setPrompt(p.join(" "));
        }

        return "Prompt updated!";
    },
    set(...v) {
        let key = v[0];
        let values = v.slice(1);
        switch (key) {
            case "raw":
                if (values.length == 0) return [`Raw active: ${settings.raw.active ? "on" : "off"}`, `Raw mode: ${settings.raw.getMode()}`];
                switch (values[0]) {
                    case "active":
                        if (values.length == 1) return `Raw active: ${settings.raw.active ? "on" : "off"}`;

                        settings.raw.active = ["true", "on"].includes(values[1].trim().toLowerCase());
                        return `Raw active ${settings.raw.active ? "on" : "off"}`;
                    case "mode":
                        if (values.length == 1) return `Raw mode: ${settings.raw.getMode()}`;

                        settings.raw.mode = rawModes[values[1].trim().toLowerCase()] || rawModes.values;
                        return `Raw mode ${settings.raw.getMode()}`;
                    default:
                        ret = {
                            message: "Unknown raw setting: " + values[0],
                            code: "NULLAPPSET",
                            errno: 110
                        };
                        return ret;
                }
                break;
            case "nesttables":
                if (values.length == 0) return `Nest tables: ${settings.nestTables ? "on" : "off"}`;

                if (values == "$reset") settings.nestTables = null;
                else settings.nestTables = values[0];

                return `Nest tables ${settings.nestTables || "off"}`;
            default:
                ret = {
                    message: "Unknown app setting: " + key,
                    code: "NULLAPPSET",
                    errno: 110
                };
                return ret;
        }
    },
    clear() {
        process.stdout.cursorTo(0, 0);
        process.stdout.clearScreenDown();
        return null;
    },
    help(...c) {},
    exit() {
        process.emit("SIGINT");
    },
};
appCommands.help = function (...c) {

};

function handleAppCommand(cmd) {
    let ret = null;

    cmd = cmd.split(" ");
    if (cmd[0] !== "_" && !!appCommands[cmd[0]]) ret = appCommands[cmd[0]](...cmd.slice(1));
    else appCommands.badCommand();

    // switch (cmd[0].toLowerCase()) {
    //     case "clear":
    //         process.stdout.cursorTo(0, 0);
    //         process.stdout.clearScreenDown();
    //         break;
    //     case "help":
    //         printHelp();
    //         break;
    //     default:
    //         ret = {
    //             message: "Unknown app command: " + cmd,
    //             code: "NULLAPPCMD",
    //             errno: 100
    //         };
    // }

    if (ret !== null && ret.errno !== undefined) throw ret;
    if (!Array.isArray(ret) && ret !== null) ret = [ret];

    return (ret === null ? null : ret.map(r => chalk.italic.green("  " + r)).join("\n"));
}

function handleSQLResponse(records) {
    if (records.length == 0) return "Returned " + chalk.yellow("0") + " rows.";
    let keys = Object.keys(records[0]);
    let data = new Array(keys.length).fill(new Array(1 + records.length));
    let lengths = new Array(keys.length);

    const clampString = (clampLength, maxLength, str) => {
        clampLength = Math.min(clampLength, maxLength);
        str = str.padStart(clampLength, " ");

        if (str.length > clampLength) str = str.substring(0, clampLength - 4) + " ...";
        else str = str.substring(0, clampLength);

        return str;
    };
    const buildRecordRow = (r, a, c) => a.concat(c[r]);

    for (let k = 0; k < keys.length; k++) {
        data[k][0] = keys[k];
        lengths[k] = [];
        lengths[k].push(keys[k].length);
        for (let r = 0; r < records.length; r++) {
            let rec = records[r][keys[k]];
            if (rec === null || rec === undefined) rec = "null";
            if (rec instanceof Date) rec = rec.toJSON();
            if (typeof rec === "object") {
                rec = JSON.parse(JSON.stringify(rec));
                rec = (rec.type || "???????").substring(0, 3) + JSON.stringify(rec.data);
            }
            rec = rec.toString();

            data[k][r + 1] = rec;
            lengths[k].push(rec.length);
        }

        data[k] = data[k].map(clampString.bind(this, 40, Math.max(...lengths[k])));
    }

    let lines = [];
    for (let r = 0; r < records.length + 1; r++) {
        let line = "| " + data.reduce(buildRecordRow.bind(null, r), []).join(" | ") + " |";
        lines.push(line);
    }

    lines.splice(1, 0, lines[0].replace(/[^|]/g, "-"));
    lines.splice(0, 0, lines[0].replace(/[^|]/g, "-"));
    lines.push(lines[0]);
    return lines.join("\n");
}

function handleSQLModify(record) {
    let id = record.insertId;
    let rows = record.affectedRows;

    if (id == 0) return "Deleted " + chalk.yellow(rows) + " record" + (rows == 1 ? "" : "s") + ".";
    else return "Altered " + chalk.yellow(rows) + " record" + (rows == 1 ? "" : "s") + ".";
}

function isValidCommand(c) {
    return c.endsWith(";") || c.endsWith(";sh") || // SQL command
        c.startsWith("/") || // internal command
        c.startsWith(">"); // js command
}

async function setDefaultPrompt() {
    setPrompt(db === null ? chalk.bold.red(`disconnected`) : `${chalk.bold.green(config.user)}@${config.host}`);
}

function setPrompt(p) {
    settings.prompt = p;
    repl.setPrompt(`${p}> `);
}

function enterRepl() {
    repl = rl.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: settings.prompt + "> "
    });
    setDefaultPrompt();

    let d = "";
    let p = null;

    repl.prompt();
    repl.on("line", (data) => {
        data = data.trim();
        d += data;

        if (isValidCommand(d)) {
            Promise.resolve(d)
                .then((ret) => {
                    if (p !== null) setPrompt(p);
                    p = null;
                    repl.pause();
                    return ret;
                })
                .then((ret) => handleCommand(ret))
                .then((ret) => {
                    if (ret !== null) logn(ret);
                    return 0;
                })
                .catch((err) => {
                    logerr(err);
                    return err.errno;
                })
                .finally((retcode) => {
                    lastRetCode = retcode;
                    repl.prompt();
                    repl.resume();
                });
            d = "";
        } else if (d != "") {
            d += " ";
            if (p === null) p = settings.prompt;
            repl.setPrompt("... ");
            repl.prompt();
        } else {
            repl.prompt();
        }
    }).on("SIGINT", () => process.emit("SIGINT"));
    process.on("SIGINT", () => {
        if (d === "") {
            logn("\nBye!");
            process.exit(lastRetCode);
        } else {
            d = "";
            if (p !== null) setPrompt(p);
            p = null;
            log("\n");
            repl.emit("line", "");
        }
    });
}

function printHelp() {

}

if (require.main === module) {
    if (yargs.argv.help) yargs.showHelp();
    else processArgs().then(enterRepl).catch(logerr);
} else module.exports = {};