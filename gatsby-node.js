"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("./constants");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const util_1 = require("./util");
// converts gatsby redirects + rewrites to S3 routing rules
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-websiteconfiguration-routingrules.html
const getRules = (pluginOptions, routes) => (routes.map(route => ({
    Condition: {
        KeyPrefixEquals: util_1.withoutLeadingSlash(route.fromPath),
        HttpErrorCodeReturnedEquals: pluginOptions.HttpErrorCodeReturnedEquals,
    },
    Redirect: {
        ReplaceKeyWith: util_1.withoutTrailingSlash(util_1.withoutLeadingSlash(route.toPath)),
        HttpRedirectCode: route.isPermanent ? '301' : '302',
        Protocol: pluginOptions.protocol,
        HostName: pluginOptions.hostname,
    },
})));
let params = {};
exports.onPreBootstrap = ({ reporter }, { bucketName }) => {
    if (!bucketName) {
        reporter.panic(`
      "bucketName" is a required option for gatsby-plugin-s3
      See docs here - https://github.com/jariz/gatsby-plugin-s3
      `);
        process.exit(1);
    }
    params = {};
};
exports.createPagesStatefully = ({ store, actions: { createPage } }, userPluginOptions) => {
    const pluginOptions = Object.assign({}, constants_1.DEFAULT_OPTIONS, userPluginOptions);
    const { redirects, pages } = store.getState();
    if (pluginOptions.generateIndexPageForRedirect) {
        const indexRedirect = redirects.find(redirect => redirect.fromPath === '/');
        const indexPage = Array.from(pages.values()).find(page => page.path === '/');
        if (indexRedirect) {
            if (!indexPage) {
                // no index page yet, create one so we can add a redirect to it's metadata when uploading
                createPage({
                    path: '/',
                    component: path_1.default.join(__dirname, './fake-index.js'),
                });
            }
            params = Object.assign({}, params, { 'index.html': {
                    WebsiteRedirectLocation: indexRedirect.toPath,
                } });
        }
    }
};
exports.onPostBuild = ({ store }, userPluginOptions) => {
    const pluginOptions = Object.assign({}, constants_1.DEFAULT_OPTIONS, userPluginOptions);
    const { redirects, pages, program } = store.getState();
    if (!pluginOptions.hostname !== !pluginOptions.protocol) { // If one of these is provided but not the other
        throw new Error(`Please either provide both 'hostname' and 'protocol', or neither of them.`);
    }
    let rewrites = [];
    let pageDataroutes = [];
    if (pluginOptions.generateMatchPathRewrites) {
        const pathsToConfigure = Array.from(pages.values())
            .filter((page) => !!page.matchPath && page.matchPath !== page.path);
        rewrites =
            pathsToConfigure.map(page => ({
                // sort of (w)hack. https://i.giphy.com/media/iN5qfn8S2qVgI/giphy.webp
                // the syntax that gatsby invented here does not work with routing rules.
                // routing rules syntax is `/app/` not `/app/*` (it's basically prefix by default)
                fromPath: page.matchPath.endsWith('*')
                    ? page.matchPath.substring(0, page.matchPath.length - 1)
                    : page.matchPath,
                toPath: page.path,
            }));
        pageDataroutes =
            pathsToConfigure.map(page => ({
                fromPath: page.matchPath.endsWith('*')
                    ? `page-data/${page.matchPath.substring(0, page.matchPath.length - 1)}`
                    : `page-data/${page.matchPath}`,
                toPath: page.path.endsWith('/')
                    ? `page-data/${page.path}page-data.json`
                    : `page-data/${page.path}/page-data.json`,
            }));
        rewrites.concat(pageDataroutes);
        console.log('PATHS, ', JSON.stringify(pathsToConfigure));
        console.log('TRANSFORMED, ', JSON.stringify(rewrites));
    }
    if (pluginOptions.mergeCachingParams) {
        params = Object.assign({}, params, constants_1.CACHING_PARAMS);
    }
    params = Object.assign({}, params, pluginOptions.params);
    let routingRules = [];
    let slsRoutingRules = [];
    const temporaryRedirects = redirects.filter(redirect => redirect.fromPath !== '/')
        .filter(redirect => !redirect.isPermanent);
    const permanentRedirects = redirects.filter(redirect => redirect.fromPath !== '/')
        .filter(redirect => redirect.isPermanent);
    if (pluginOptions.generateRoutingRules) {
        routingRules = [
            ...getRules(pluginOptions, temporaryRedirects),
            ...getRules(pluginOptions, rewrites),
        ];
        if (!pluginOptions.generateRedirectObjectsForPermanentRedirects) {
            routingRules.push(...getRules(pluginOptions, permanentRedirects));
        }
        if (routingRules.length > 50) {
            throw new Error(`${routingRules.length} routing rules provided, the number of routing rules 
in a website configuration is limited to 50.
Try setting the 'generateRedirectObjectsForPermanentRedirects' configuration option.`);
        }
        slsRoutingRules = routingRules.map(({ Redirect, Condition }) => ({
            RoutingRuleCondition: Condition,
            RedirectRule: Redirect,
        }));
    }
    fs_1.default.writeFileSync(path_1.default.join(program.directory, './.cache/s3.routingRules.json'), JSON.stringify(routingRules));
    fs_1.default.writeFileSync(path_1.default.join(program.directory, './.cache/s3.sls.routingRules.json'), JSON.stringify(slsRoutingRules));
    if (pluginOptions.generateRedirectObjectsForPermanentRedirects) {
        fs_1.default.writeFileSync(path_1.default.join(program.directory, './.cache/s3.redirectObjects.json'), JSON.stringify(permanentRedirects));
    }
    fs_1.default.writeFileSync(path_1.default.join(program.directory, './.cache/s3.params.json'), JSON.stringify(params));
    fs_1.default.writeFileSync(path_1.default.join(program.directory, './.cache/s3.config.json'), JSON.stringify(pluginOptions));
};
//# sourceMappingURL=gatsby-node.js.map