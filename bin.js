#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("@babel/polyfill");
require("fs-posix");
const s3_1 = __importDefault(require("aws-sdk/clients/s3"));
const yargs_1 = __importDefault(require("yargs"));
const constants_1 = require("./constants");
const fs_extra_1 = require("fs-extra");
const klaw_1 = __importDefault(require("klaw"));
const pretty_error_1 = __importDefault(require("pretty-error"));
const stream_to_promise_1 = __importDefault(require("stream-to-promise"));
const ora_1 = __importDefault(require("ora"));
const chalk_1 = __importDefault(require("chalk"));
const path_1 = require("path");
const url_1 = require("url");
const fs_1 = __importDefault(require("fs"));
const util_1 = __importDefault(require("util"));
const minimatch_1 = __importDefault(require("minimatch"));
const mime_1 = __importDefault(require("mime"));
const inquirer_1 = __importDefault(require("inquirer"));
const aws_sdk_1 = require("aws-sdk");
const crypto_1 = require("crypto");
const is_ci_1 = __importDefault(require("is-ci"));
const util_2 = require("./util");
const async_1 = require("async");
const cli = yargs_1.default();
const pe = new pretty_error_1.default();
const OBJECTS_TO_REMOVE_PER_REQUEST = 1000;
const promisifiedParallelLimit = util_1.default.promisify(async_1.parallelLimit);
const guessRegion = (s3, constraint) => (constraint || s3.config.region || aws_sdk_1.config.region);
const getBucketInfo = async (config, s3) => {
    try {
        const { $response } = await s3.getBucketLocation({ Bucket: config.bucketName }).promise();
        const detectedRegion = guessRegion(s3, ($response.data && $response.data.LocationConstraint));
        return {
            exists: true,
            region: detectedRegion,
        };
    }
    catch (ex) {
        if (ex.code === 'NoSuchBucket') {
            return {
                exists: false,
                region: guessRegion(s3),
            };
        }
        else {
            throw ex;
        }
    }
};
const getParams = (path, params) => {
    let returned = {};
    for (const key of Object.keys(params)) {
        if (minimatch_1.default(path, key)) {
            returned = Object.assign({}, returned, params[key]);
        }
    }
    return returned;
};
const listAllObjects = async (s3, bucketName) => {
    const list = [];
    let token;
    do {
        const response = await s3.listObjectsV2({
            Bucket: bucketName,
            ContinuationToken: token,
        }).promise();
        if (response.Contents) {
            list.push(...response.Contents);
        }
        token = response.NextContinuationToken;
    } while (token);
    return list;
};
const createSafeS3Key = (key) => {
    if (path_1.sep === '\\') {
        return key.replace(/\\/g, '/');
    }
    return key;
};
const deploy = async ({ yes, bucket }) => {
    const spinner = ora_1.default({ text: 'Retrieving bucket info...', color: 'magenta' }).start();
    const uploadQueue = [];
    try {
        const config = await fs_extra_1.readJson(constants_1.CACHE_FILES.config);
        const params = await fs_extra_1.readJson(constants_1.CACHE_FILES.params);
        const routingRules = await fs_extra_1.readJson(constants_1.CACHE_FILES.routingRules);
        const redirectObjects = fs_1.default.existsSync(constants_1.CACHE_FILES.redirectObjects)
            ? await fs_extra_1.readJson(constants_1.CACHE_FILES.redirectObjects)
            : [];
        // Override the bucket name if it is set via command line
        if (bucket) {
            config.bucketName = bucket;
        }
        const s3 = new s3_1.default({
            region: config.region,
            endpoint: config.customAwsEndpointHostname,
        });
        const { exists, region } = await getBucketInfo(config, s3);
        if (is_ci_1.default && !yes) {
            yes = true;
        }
        if (!yes) {
            spinner.stop();
            console.log(chalk_1.default `
    {underline Please review the following:} ({dim pass -y next time to skip this})

    Deploying to bucket: {cyan.bold ${config.bucketName}}
    In region: {yellow.bold ${region || 'UNKNOWN!'}}
    Gatsby will: ${!exists
                ? chalk_1.default `{bold.greenBright CREATE}`
                : chalk_1.default `{bold.blueBright UPDATE} {dim (any existing website configuration will be overwritten!)}`}
`);
            const { confirm } = await inquirer_1.default.prompt([{
                    message: 'OK?',
                    name: 'confirm',
                    type: 'confirm',
                }]);
            if (!confirm) {
                throw new Error('User aborted!');
            }
            spinner.start();
        }
        spinner.text = 'Configuring bucket...';
        spinner.color = 'yellow';
        if (!exists) {
            const createParams = {
                Bucket: config.bucketName,
                ACL: config.acl === null ? undefined : (config.acl || 'public-read'),
            };
            if (config.region) {
                createParams.CreateBucketConfiguration = {
                    LocationConstraint: config.region,
                };
            }
            await s3.createBucket(createParams).promise();
        }
        if (config.enableS3StaticWebsiteHosting) {
            const websiteConfig = {
                Bucket: config.bucketName,
                WebsiteConfiguration: {
                    IndexDocument: {
                        Suffix: 'index.html',
                    },
                    ErrorDocument: {
                        Key: '404.html',
                    },
                },
            };
            if (routingRules.length) {
                websiteConfig.WebsiteConfiguration.RoutingRules = routingRules;
            }
            await s3.putBucketWebsite(websiteConfig).promise();
        }
        spinner.text = 'Listing objects...';
        spinner.color = 'green';
        const objects = await listAllObjects(s3, config.bucketName);
        spinner.color = 'cyan';
        spinner.text = 'Syncing...';
        const publicDir = path_1.resolve('./public');
        const stream = klaw_1.default(publicDir);
        const isKeyInUse = {};
        stream.on('data', async ({ path, stats }) => {
            if (!stats.isFile()) {
                return;
            }
            uploadQueue.push(async_1.asyncify(async () => {
                const key = createSafeS3Key(path_1.relative(publicDir, path));
                const readStream = fs_1.default.createReadStream(path);
                const hashStream = readStream.pipe(crypto_1.createHash('md5').setEncoding('hex'));
                const data = await stream_to_promise_1.default(hashStream);
                const tag = `"${data}"`;
                const object = objects.find(currObj => currObj.Key === key && currObj.ETag === tag);
                isKeyInUse[key] = true;
                if (!object) {
                    try {
                        const upload = new s3_1.default.ManagedUpload({
                            service: s3,
                            params: Object.assign({ Bucket: config.bucketName, Key: key, Body: fs_1.default.createReadStream(path), ACL: config.acl === null ? undefined : (config.acl || 'public-read'), ContentType: mime_1.default.getType(path) || 'application/octet-stream' }, getParams(key, params)),
                        });
                        upload.on('httpUploadProgress', (evt) => {
                            spinner.text = chalk_1.default `Syncing...
{dim   Uploading {cyan ${key}} ${evt.loaded.toString()}/${evt.total.toString()}}`;
                        });
                        await upload.promise();
                        spinner.text = chalk_1.default `Syncing...\n{dim   Uploaded {cyan ${key}}}`;
                    }
                    catch (ex) {
                        console.error(ex);
                        process.exit(1);
                    }
                }
            }));
        });
        const base = (config.protocol && config.hostname) ? `${config.protocol}://${config.hostname}` : null;
        uploadQueue.push(...redirectObjects.map(redirect => async_1.asyncify(async () => {
            const { fromPath, toPath: redirectPath } = redirect;
            const redirectLocation = base ? url_1.resolve(base, redirectPath) : redirectPath;
            let key = util_2.withoutLeadingSlash(fromPath);
            if (/\/$/.test(key)) {
                key = path_1.join(key, 'index.html');
            }
            key = createSafeS3Key(key);
            const tag = `"${crypto_1.createHash('md5').update(redirectLocation).digest('hex')}"`;
            const object = objects.find(currObj => currObj.Key === key && currObj.ETag === tag);
            isKeyInUse[key] = true;
            if (object) {
                // object with exact hash already exists, abort.
                return;
            }
            try {
                const upload = new s3_1.default.ManagedUpload({
                    service: s3,
                    params: Object.assign({ Bucket: config.bucketName, Key: key, Body: redirectLocation, ACL: config.acl === null ? undefined : (config.acl || 'public-read'), ContentType: 'application/octet-stream', WebsiteRedirectLocation: redirectLocation }, getParams(key, params)),
                });
                await upload.promise();
                spinner.text = chalk_1.default `Syncing...
{dim   Created Redirect {cyan ${key}} => {cyan ${redirectLocation}}}\n`;
            }
            catch (ex) {
                spinner.fail(chalk_1.default `Upload failure for object {cyan ${key}}`);
                console.error(pe.render(ex));
                process.exit(1);
            }
        })));
        // tslint:disable-next-line:no-any todo: find out why the typing won't allow this as-is
        await stream_to_promise_1.default(stream);
        await promisifiedParallelLimit(uploadQueue, 20);
        if (config.removeNonexistentObjects) {
            const objectsToRemove = objects.map(obj => ({ Key: obj.Key }))
                .filter(obj => obj.Key && !isKeyInUse[obj.Key]);
            for (let i = 0; i < objectsToRemove.length; i += OBJECTS_TO_REMOVE_PER_REQUEST) {
                const objectsToRemoveInThisRequest = objectsToRemove.slice(i, i + OBJECTS_TO_REMOVE_PER_REQUEST);
                spinner.text =
                    `Removing objects ${i + 1} to ${i +
                        objectsToRemoveInThisRequest.length} of ${objectsToRemove.length}`;
                await s3.deleteObjects({
                    Bucket: config.bucketName,
                    Delete: {
                        Objects: objectsToRemoveInThisRequest,
                        Quiet: true,
                    },
                }).promise();
            }
        }
        spinner.succeed('Synced.');
        if (config.enableS3StaticWebsiteHosting) {
            const s3WebsiteDomain = util_2.getS3WebsiteDomainUrl(region || 'us-east-1');
            console.log(chalk_1.default `
            {bold Your website is online at:}
            {blue.underline http://${config.bucketName}.${s3WebsiteDomain}}
            `);
        }
        else {
            console.log(chalk_1.default `
            {bold Your website has now been published to:}
            {blue.underline ${config.bucketName}}
            `);
        }
    }
    catch (ex) {
        spinner.fail('Failed.');
        console.error(pe.render(ex));
        process.exit(1);
    }
};
cli
    .command(['deploy', '$0'], 'Deploy bucket. If it doesn\'t exist, it will be created. Otherwise, it will be updated.', (args) => {
    args.option('yes', {
        alias: 'y',
        describe: 'Skip confirmation prompt',
        boolean: true,
    });
    args.option('bucket', {
        alias: 'b',
        describe: 'Bucket name (if you wish to override default bucket name)',
    });
}, deploy)
    .wrap(cli.terminalWidth())
    .demandCommand(1, `Pass --help to see all available commands and options.`)
    .strict()
    .showHelpOnFail(true)
    .recommendCommands()
    .parse(process.argv.slice(2));
//# sourceMappingURL=bin.js.map