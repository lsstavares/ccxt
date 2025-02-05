// ---------------------------------------------------------------------------
// Usage: npm run transpileWs
// ---------------------------------------------------------------------------

import fs from 'fs';
import log from 'ololog';
import ccxt from '../js/ccxt.js';
import ansi  from 'ansicolor'
import {
    replaceInFile,
    copyFile,
    overwriteFile,
    createFolder,
    createFolderRecursively,
} from './fsLocal.js';
import Exchange from '../js/src/base/Exchange.js';
import {  Transpiler, parallelizeTranspiling, isMainEntry } from './transpile.js';

const exchanges = JSON.parse (fs.readFileSync("./exchanges.json", "utf8"));
const wsExchangeIds = exchanges.ws;

const { unCamelCase, precisionConstants, safeString, unique } = ccxt;

ansi.nice
// ============================================================================

class CCXTProTranspiler extends Transpiler {

    getBaseClass () {
        return new Exchange ()
    }

    createPythonClassDeclaration (className, baseClass) {
        const baseClasses = (baseClass.indexOf ('Rest') >= 0) ?
            [ 'ccxt.async_support.' + baseClass.replace('Rest', '') ] :
            [ baseClass ]
        return 'class ' + className + '(' +  baseClasses.join (', ') + '):'
    }

    createPythonClassImports (baseClass, async = false) {

        const baseClasses = {
            'Exchange': 'base.exchange',
        }

        async = (async ? '.async_support' : '')

        if (baseClass.indexOf ('Rest') >= 0) {
            return [
                // 'from ccxt.async_support' + ' import ' + baseClass,
                "import ccxt.async_support"
            ]
        } else {
            return [
                'from ccxt.pro.' + baseClass + ' import ' + baseClass // on the JS side we add to append `Rest` to the base class name
            ]
        }
        // return [
        //     (baseClass.indexOf ('ccxt.') === 0) ?
        //         ('import ccxt' + async + ' as ccxt') :
        //         ('from ccxtpro.' + safeString (baseClasses, baseClass, baseClass) + ' import ' + baseClass)
        // ]
    }

    createPythonClassHeader (ccxtImports, bodyAsString) {
        const imports = [
            ... ccxtImports,
        ]
        const arrayCacheClasses = bodyAsString.match (/\bArrayCache(?:[A-Z][A-Za-z]+)?\b/g)
        if (arrayCacheClasses) {
            const uniqueArrayCacheClasses = unique (arrayCacheClasses).sort ()
            const arrayCacheImport = 'from ccxt.async_support.base.ws.cache import ' + uniqueArrayCacheClasses.join (', ')
            imports.push (arrayCacheImport)
        }
        const orderBookClasses = bodyAsString.match(/\s(Asks|Bids)\(.*\)/g)
        if (orderBookClasses) {
            const uniqueOrderBookClasses = unique (orderBookClasses.map(match => match.replace(/\(.*\)/, '').trim())).sort ()
            const orderBookSideImport = 'from ccxt.async_support.base.ws.order_book_side import ' + uniqueOrderBookClasses.join (', ')
            imports.push (orderBookSideImport)
        }
        return [
            "# -*- coding: utf-8 -*-",
            "",
            "# PLEASE DO NOT EDIT THIS FILE, IT IS GENERATED AND WILL BE OVERWRITTEN:",
            "# https://github.com/ccxt/ccxt/blob/master/CONTRIBUTING.md#how-to-contribute-code",
            "",
            ... imports,
        ]
    }

    createPHPClassDeclaration (className, baseClass) {
        let lines = []
        if (baseClass.indexOf ('Rest') >= 0) {
            //     lines = lines.concat ([
            //         '',
            //         // '    use ClientTrait;'
            //     ])
            lines.push('class ' + className + ' extends ' + '\\ccxt\\async\\' +  baseClass.replace ('Rest', '') + ' {')
        } else {
            lines.push('class ' + className + ' extends ' + '\\ccxt\\pro\\' +  baseClass + ' {')
        }
        return lines.join ("\n")
    }

    createPHPClassHeader (className, baseClass, bodyAsString) {
        return [
            "<?php",
            "",
            "namespace ccxt\\pro;",
            "",
            "// PLEASE DO NOT EDIT THIS FILE, IT IS GENERATED AND WILL BE OVERWRITTEN:",
            "// https://github.com/ccxt/ccxt/blob/master/CONTRIBUTING.md#how-to-contribute-code",
            "",
            "use Exception; // a common import",
        ]
    }

    sortExchangeCapabilities (code) {
        return false
    }

    exportTypeScriptClassNames (file, classes) {

        log.bright.cyan ('Exporting WS TypeScript class names →', file.yellow)

        const commonImports = [
            '        export const exchanges: string[]',
            '        class Exchange  extends ExchangePro {}'
        ]

        const replacements = [
            {
                file:file,
                regex: /\n\n\s+export\snamespace\spro\s{\n\s+[\s\S]+}/,
                replacement: "\n\n    export namespace pro {\n" + commonImports.join('\n') + '\n' + Object.keys (classes).map (className => {
                    return '        class ' + className + ' extends Exchange {}'
                }).join ("\n") + "\n    }\n}"
            }
        ]

        replacements.forEach (({ file, regex, replacement }) => {
            replaceInFile (file, regex, replacement)
        })

    }

    // -----------------------------------------------------------------------
    wsTestsDirectories = {
        ts: './ts/src/pro/test/',
        py: './python/ccxt/pro/test/',
        php: './php/pro/test/',
    };

    transpileWsTests (){
        this.transpileWsCacheTest();
        this.transpileWsOrderBookTest();
        this.transpileWsExchangeTests();
    }

    transpileWsExchangeTests () {
        const wsCollectedTests = [];
        for (const currentFolder of ['Exchange/']) {
            const fileNames = this.readTsFileNames(this.wsTestsDirectories.ts + currentFolder);
            for (const testName of fileNames) {
                const testNameUncameled = this.uncamelcaseName(testName);
                const test = {
                    base: false,
                    name: testName,
                    tsFile: this.wsTestsDirectories.ts + currentFolder + testName + '.ts',
                    pyFileAsync: this.wsTestsDirectories.py + currentFolder + testNameUncameled + '.py',
                    phpFileAsync: this.wsTestsDirectories.php + currentFolder + testNameUncameled + '.php',
                };
                wsCollectedTests.push(test);
            }
        }

        this.transpileAndSaveExchangeTests (wsCollectedTests);
    }

    arrayEqualFunctionForPhp = (
        `function equals($a, $b) {` +
        `\n   return json_encode($a) === json_encode($b);` +
        `\n}`+
        '\n'
    );

    arrayEqualFunctionForPy = (
        `def equals(a, b):`+
        `\n    return a == b`+
        '\n'
    );

    transpileWsOrderBookTest() {
        const currentFolder = 'base/';
        const testName = 'test.OrderBook';
        const testNameUncameled = this.uncamelcaseName(testName);
        const test = {
            base: true,
            name: testName,
            tsFile: this.wsTestsDirectories.ts + currentFolder + testName + '.ts',
            pyFileSync: this.wsTestsDirectories.py + currentFolder + testNameUncameled + '.py',
            pyHeaders: ['\n', 'from ccxt.async_support.base.ws.order_book import OrderBook, IndexedOrderBook, CountedOrderBook  # noqa: F402', '\n', '\n', this.arrayEqualFunctionForPy, '\n'],
            phpHeaders: [ '\n', this.arrayEqualFunctionForPhp, '\n'],
            phpFileSync: this.wsTestsDirectories.php + currentFolder + testNameUncameled + '.php',
        };
        this.transpileAndSaveExchangeTests ([test]);
    }

    transpileWsCacheTest() {
        const currentFolder = 'base/';
        const testName = 'test.Cache';
        const testNameUncameled = this.uncamelcaseName(testName);
        const test = {
            base: true,
            name: testName,
            tsFile: this.wsTestsDirectories.ts + currentFolder + testName + '.ts',
            pyFileSync: this.wsTestsDirectories.py + currentFolder + testNameUncameled + '.py',
            pyHeaders: ['from ccxt.async_support.base.ws.cache import ArrayCache, ArrayCacheByTimestamp, ArrayCacheBySymbolById, ArrayCacheBySymbolBySide  # noqa: F402', '\n', '\n', this.arrayEqualFunctionForPy, '\n'],
            phpHeaders: [ '\n', this.arrayEqualFunctionForPhp, '\n'],
            phpFileSync: this.wsTestsDirectories.php + currentFolder + testNameUncameled + '.php',
        };
        this.transpileAndSaveExchangeTests ([test]);
    }

    // -----------------------------------------------------------------------

    async transpileEverything (force = false, child = false) {

        // default pattern is '.js'
        // const [ /* node */, /* script */, pattern ] = process.argv.filter (x => !x.startsWith ('--'))
        const exchanges = process.argv.slice (2).filter (x => !x.startsWith ('--'))
            // , python2Folder = './python/ccxtpro/', // CCXT Pro does not support Python 2
            , python3Folder = './python/ccxt/pro/'
            , phpAsyncFolder = './php/pro/'
            , jsFolder = './js/src/pro/'
            , tsFolder = './ts/src/pro/'
            , options = { /* python2Folder, */ python3Folder, phpAsyncFolder, jsFolder, exchanges }

        // createFolderRecursively (python2Folder)
        createFolderRecursively (python3Folder)
        createFolderRecursively (phpAsyncFolder)

        const classes = this.transpileDerivedExchangeFiles (tsFolder, options, '.ts', force, child || exchanges.length)

        this.transpileWsTests ()

        if (child) {
            return
        }

        if (classes === null) {
            log.bright.yellow ('0 files transpiled.')
            return;
        }

        //*/

        // this.transpileErrorHierarchy ({ tsFilename })

        log.bright.green ('Transpiled successfully.')
    }
}

// ============================================================================
// main entry point
if (isMainEntry(import.meta.url)) { // called directly like `node module`
    const transpiler = new CCXTProTranspiler ()
    const test = process.argv.includes ('--test') || process.argv.includes ('--tests');
    const force = process.argv.includes ('--force')
    const multiprocess = process.argv.includes ('--multiprocess') || process.argv.includes ('--multi')
    const child = process.argv.includes ('--child')
    if (!child && !multiprocess) {
        log.bright.green ('isForceTranspile', force)
    }
    if (test) {
        transpiler.transpileWsTests ()
    } 
    else if (multiprocess) {
        parallelizeTranspiling (exchanges.ws)
    } else {
        (async () => {
            await transpiler.transpileEverything (force, child)
        })()
    }

} else {

    // do nothing if required as a module
}

// ============================================================================

export default CCXTProTranspiler
