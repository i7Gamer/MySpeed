import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, "client", "public", "third-party-notices.txt");
const HARFBUZZ_SOURCE = "https://github.com/harfbuzz/harfbuzzjs";
const SUPPORTED_HARFBUZZ_VERSION = "0.10.0";
const EXTRACTOR_MANIFEST = "extractor-closure.json";
const LOCK_IDENTIFIER_INDEX = 0;
const LOCK_METADATA_INDEX = 2;

export const formatThirdPartyNotices = ({version, packageLicense, apacheLicense, extractorNotices = []}) => `MySpeed third-party notices

harfbuzzjs ${version}
Source: ${HARFBUZZ_SOURCE}
License: MIT and Apache-2.0 components

--- harfbuzzjs LICENSE ---
${packageLicense.trim()}

--- Apache License 2.0 ---
${apacheLicense.trim()}
${extractorNotices.map(({name, version: extractorVersion, source, license, licenseTexts}) => `
${name} ${extractorVersion}
Source: ${source}
License: ${license}

${licenseTexts.map((text, index) => `--- ${name} LICENSE${licenseTexts.length > 1 ? ` ${index + 1}` : ""} ---
${text.trim()}`).join("\n\n")}
`).join("")}
`;

const withoutTrailingCommas = (source) => {
    let output = "";
    let quoted = false;
    let escaped = false;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quoted) {
            output += character;
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') {
            quoted = true;
            output += character;
            continue;
        }
        if (character === ",") {
            let next = index + 1;
            while (/\s/.test(source[next] ?? "")) next++;
            if (source[next] === "}" || source[next] === "]") continue;
        }
        output += character;
    }

    return output;
};

export const parseBunLock = (source) => JSON.parse(withoutTrailingCommas(source));

const packageIdentity = (identifier) => {
    const separator = identifier.lastIndexOf("@");
    if (separator <= 0 || separator === identifier.length - 1)
        throw new Error(`Unrecognised Bun lock package identifier ${identifier}`);
    return {name: identifier.slice(0, separator), version: identifier.slice(separator + 1)};
};

const dependencyKey = (packages, parent, dependency) => {
    const nested = `${parent}/${dependency}`;
    if (packages[nested]) return nested;
    if (packages[dependency]) return dependency;
    throw new Error(`Extractor dependency ${parent} refers to missing lock package ${dependency}`);
};

export const extractorClosure = (lock, roots) => {
    const packages = lock.packages ?? {};
    const closure = new Map();

    const visit = (key) => {
        if (closure.has(key)) return;
        const entry = packages[key];
        if (!Array.isArray(entry)) throw new Error(`Extractor lock root or dependency ${key} is missing`);
        const identity = packageIdentity(entry[LOCK_IDENTIFIER_INDEX]);
        closure.set(key, identity);
        for (const dependency of Object.keys(entry[LOCK_METADATA_INDEX]?.dependencies ?? {}))
            visit(dependencyKey(packages, key, dependency));
    };

    for (const root of roots) visit(root);
    return closure;
};

export const reviewedExtractorNotices = ({root, project, lock}) => {
    const licenseDirectory = path.join(root, "scripts", "licenses");
    const manifest = JSON.parse(fs.readFileSync(path.join(licenseDirectory, EXTRACTOR_MANIFEST), "utf8"));
    const closure = extractorClosure(lock, manifest.roots);
    const reviewedKeys = Object.keys(manifest.packages).sort();
    const lockedKeys = [...closure.keys()].sort();

    const unexpected = lockedKeys.filter((key) => !manifest.packages[key]);
    const missing = reviewedKeys.filter((key) => !closure.has(key));
    if (unexpected.length > 0 || missing.length > 0)
        throw new Error(`Extractor notice closure differs from the reviewed manifest; unexpected: `
            + `${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);

    for (const rootName of manifest.roots) {
        const wanted = manifest.packages[rootName]?.version;
        const declared = project.dependencies?.[rootName];
        if (declared !== wanted)
            throw new Error(`No maintained notices for direct dependency ${rootName} ${declared ?? "missing"}`);
    }

    return reviewedKeys.map((key) => {
        const reviewed = manifest.packages[key];
        const locked = closure.get(key);
        if (locked.version !== reviewed.version)
            throw new Error(`No maintained notices for ${key} lock resolution ${locked.version}`);
        if (locked.name !== key.split("/").at(-1) && key !== locked.name
            && !key.endsWith(`/${locked.name}`))
            throw new Error(`Reviewed lock key ${key} resolves unexpected package ${locked.name}`);

        const licenseTexts = reviewed.licenseFiles.map((filename) =>
            fs.readFileSync(path.join(licenseDirectory, filename), "utf8"));
        return {...reviewed, name: locked.name, licenseTexts};
    });
};

export const generateThirdPartyNotices = ({root = PROJECT_ROOT, output = DEFAULT_OUTPUT} = {}) => {
    const project = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const version = project.dependencies?.harfbuzzjs;
    if (version !== SUPPORTED_HARFBUZZ_VERSION)
        throw new Error(`No maintained HarfBuzz notices for dependency version ${version ?? "missing"}`);

    const packageLicense = fs.readFileSync(
        path.join(root, "scripts", "licenses", `harfbuzzjs-${version}.txt`), "utf8");
    const apacheLicense = fs.readFileSync(path.join(root, "scripts", "licenses", "Apache-2.0.txt"), "utf8");
    const lock = parseBunLock(fs.readFileSync(path.join(root, "bun.lock"), "utf8"));
    const extractorNotices = reviewedExtractorNotices({root, project, lock});
    const notices = formatThirdPartyNotices({version, packageLicense, apacheLicense, extractorNotices});

    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, notices);
    return notices;
};

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) generateThirdPartyNotices();
