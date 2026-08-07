import fs from "node:fs";
const filePath = process.cwd() + "/data/logs/error.log";

export default (error) => {
    const date = new Date().toLocaleString();
    const lineStarter = fs.existsSync(filePath) ? "\n\n" : "# Found a bug? Report it here: https://github.com/i7Gamer/MySpeed/issues\n\n";

    console.error("An error occurred: " + error.message);

    fs.writeFile(filePath, lineStarter + "## " + date + "\n" + error, {flag: 'a+'}, err => {
        if (err) console.error("Could not save error log file.", error);

        process.exit(1);
    });
};