// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const NativeModule = require('native_module'); //用于管理js模块，实现位于lib/internal/bootstrap_node.js中
const util = require('util');
const internalModule = require('internal/module');
const vm = require('vm');
const assert = require('assert').ok; //主要用于断言，如果表达式不符合预期，就抛出一个错误。assert方法接受两个参数，当第一个参数对应的布尔值为true时，不会有任何提示，返回undefined。当第一个参数对应的布尔值为false时，会抛出一个错误，该错误的提示信息就是第二个参数设定的字符串。ok是assert方法的另一个名字，与assert方法完全一样。
const fs = require('fs'); //fs是filesystem的缩写，该模块提供本地文件的读写能力，基本上是POSIX文件操作命令的简单包装。但是，这个模块几乎对所有操作提供异步和同步两种操作方式，供开发者选择。
const internalFS = require('internal/fs'); //内部fs模块
const path = require('path');

//Node在启动时，会生成一个全局变量process，并提供Binding()方法来协助加载内建模块。 感兴趣了解 https://book.douban.com/reading/29343610/
const internalModuleReadFile = process.binding('fs').internalModuleReadFile; // 读取文件内容
const internalModuleStat = process.binding('fs').internalModuleStat; //判断是文件夹还是文件  以及是否存在,可以查看 http://yanglimei.com/2016/09/21/nodemodulerewrite.html
const preserveSymlinks = !!process.binding('config').preserveSymlinks;


// stat 用来判断文件目录是否存在，以及路径类型 是文件夹还是文件
function stat(filename) { //filename:路径
  filename = path._makeLong(filename);
  const cache = stat.cache;

  // 如果有缓存
  if (cache !== null) {
    const result = cache.get(filename);

    // 如果缓存中有该路径直接返回
    if (result !== undefined) return result;
  }

  // internalModuleStat头部引入，用来判断是文件夹还是文件，以及是否存在
  const result = internalModuleStat(filename); 
  // 如果有缓存，则将新路径加入缓存中
  if (cache !== null) cache.set(filename, result);

  //并返回结果
  return result;
}
stat.cache = null;


function Module(id, parent) {
  this.id = id;
  this.exports = {};
  this.parent = parent;
  if (parent && parent.children) {
    parent.children.push(this);
  }

  this.filename = null;
  this.loaded = false;
  this.children = [];
}
module.exports = Module;

Module._cache = Object.create(null);
Module._pathCache = Object.create(null);
Module._extensions = Object.create(null);
var modulePaths = [];
Module.globalPaths = [];

Module.wrapper = NativeModule.wrapper;
Module.wrap = NativeModule.wrap;
Module._debug = util.debuglog('module'); //这个方法用来打印出调试信息,具体可以看 https://chyingp.gitbooks.io/nodejs/%E6%A8%A1%E5%9D%97/util.html

// We use this alias for the preprocessor that filters it out
const debug = Module._debug;


// given a module name, and a list of paths to test, returns the first
// matching file in the following precedence.
//
// require("a.<ext>")
//   -> a.<ext>
//
// require("a")
//   -> a
//   -> a.<ext>
//   -> a/index.<ext>

// check if the directory is a package.json dir
const packageMainCache = Object.create(null);

function readPackage(requestPath) {
  const entry = packageMainCache[requestPath];
  if (entry)
    return entry;

  const jsonPath = path.resolve(requestPath, 'package.json');
  const json = internalModuleReadFile(path._makeLong(jsonPath));

  if (json === undefined) {
    return false;
  }

  try {
    var pkg = packageMainCache[requestPath] = JSON.parse(json).main;
  } catch (e) {
    e.path = jsonPath;
    e.message = 'Error parsing ' + jsonPath + ': ' + e.message;
    throw e;
  }
  return pkg;
}

// 读取package.json文件,返回路径
function tryPackage(requestPath, exts, isMain) {
  var pkg = readPackage(requestPath);

  if (!pkg) return false;

  var filename = path.resolve(requestPath, pkg);
  return tryFile(filename, isMain) ||
         tryExtensions(filename, exts, isMain) ||
         tryExtensions(path.resolve(filename, 'index'), exts, isMain);
}

// In order to minimize unnecessary lstat() calls,
// this cache is a list of known-real paths.
// Set to an empty Map to reset.
const realpathCache = new Map();

// check if the file exists and is not a directory
// if using --preserve-symlinks and isMain is false,
// keep symlinks intact, otherwise resolve to the
// absolute realpath.
// 判断路径是否存在
// 如果用了--preserve-symlinks 命令并且 非主入口文件，则保证符号路径完整
// 否则解析为绝对实际路径
function tryFile(requestPath, isMain) {
  const rc = stat(requestPath);
  if (preserveSymlinks && !isMain) {
    return rc === 0 && path.resolve(requestPath);
  }
  return rc === 0 && toRealPath(requestPath);
}


// fs.realpathSync()用来获取当前执行js文件的真实路径
function toRealPath(requestPath) {
  return fs.realpathSync(requestPath, {
    [internalFS.realpathCacheKey]: realpathCache
  });
}

// given a path check a the file exists with any of the set extensions
// 给定一个路径，检查文件是否存在任何一个扩展名
function tryExtensions(p, exts, isMain) {
  for (var i = 0; i < exts.length; i++) {
    const filename = tryFile(p + exts[i], isMain);

    if (filename) {
      return filename;
    }
  }
  return false;
}

var warned = false;
Module._findPath = function(request, paths, isMain) {//request 当前加载的模块名称,paths Module._resolveLookupPaths()函数返回一个数组[id , paths],即模块可能在的所有路径，/* isMain */ false  是不是主入口文件

  //path.isAbsolute()判断参数 path 是否是绝对路径。
  if (path.isAbsolute(request)) {  
    paths = [''];
  } else if (!paths || paths.length === 0) {
    return false;
  }


  var cacheKey = request + '\x00' +
                (paths.length === 1 ? paths[0] : paths.join('\x00'));
  var entry = Module._pathCache[cacheKey];

  //判断是否在缓存中，如果有则直接返回 
  if (entry)
    return entry;

  //如果不在缓存中，则开始查找
  var exts;
  // 当前加载的模块名称大于0位并且最后一位是 ／ ，即是否有后缀的目录斜杠
  var trailingSlash = request.length > 0 &&
                      request.charCodeAt(request.length - 1) === 47/*/*/;

  // For each path
  // 循环每一个可能的路径
  for (var i = 0; i < paths.length; i++) {

    // Don't search further if path doesn't exist
    // 如果路径存在就继续执行，不存在就继续检验下一个路径 stat 获取路径状态
    const curPath = paths[i];
    if (curPath && stat(curPath) < 1) continue;
    var basePath = path.resolve(curPath, request); //生成绝对路径
    var filename;

    //stat 头部定义的函数，用来获取路径状态，判断路径类型，是文件还是文件夹
    var rc = stat(basePath); 
    if (!trailingSlash) {
      if (rc === 0) {  // File. // 若是文件

        // 如果是使用模块的符号路径而不是真实路径，并且不是主入口文件
        if (preserveSymlinks && !isMain) {  
          filename = path.resolve(basePath);
        } else {
          filename = toRealPath(basePath);
        }

      } else if (rc === 1) {  // Directory. // 若是目录
        if (exts === undefined)
          //目录中是否存在 package.json 
          exts = Object.keys(Module._extensions);
        filename = tryPackage(basePath, exts, isMain);
      }

      // 如果尝试了上面都没有得到filename 匹配所有扩展名进行尝试，是否存在
      if (!filename) {
        // try it with each of the extensions
        if (exts === undefined)
          exts = Object.keys(Module._extensions);
        // 该模块文件加上后缀名js .json .node进行尝试，是否存在 
        filename = tryExtensions(basePath, exts, isMain);
      }
    }

    if (!filename && rc === 1) {  // Directory.
      if (exts === undefined)
        // 目录中是否存在 package.json 
        exts = Object.keys(Module._extensions);
      filename = tryPackage(basePath, exts, isMain);
    }

    if (!filename && rc === 1) {  // Directory.
      // try it with each of the extensions at "index"
      // 是否存在目录名 + index + 后缀名
      // 尝试 index.js index.json index.node
      if (exts === undefined)
        exts = Object.keys(Module._extensions);
      filename = tryExtensions(path.resolve(basePath, 'index'), exts, isMain);
    }

    if (filename) {
      // Warn once if '.' resolved outside the module dir
      if (request === '.' && i > 0) {
        if (!warned) {
          warned = true;
          process.emitWarning(
            'warning: require(\'.\') resolved outside the package ' +
            'directory. This functionality is deprecated and will be removed ' +
            'soon.',
            'DeprecationWarning', 'DEP0019');
        }
      }

      // 将找到的文件路径存入返回缓存，然后返回
      Module._pathCache[cacheKey] = filename;
      return filename;
    }
  }

  // 所以从这里可以看出，对于具体的文件的优先级：
  // 1. 具体文件。
  // 2. 加上后缀。
  // 3. package.json
  // 4  index加上后缀
  // 候选路径以当前文件夹，nodejs系统文件夹和node_module中的文件夹为候选，以上述顺序找到任意一个，
  // 就直接返回

  // 没有找到文件，返回false 
  return false;
};

// 'node_modules' character codes reversed
var nmChars = [ 115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110 ];
var nmLen = nmChars.length;
if (process.platform === 'win32') {
  // 'from' is the __dirname of the module.
  Module._nodeModulePaths = function(from) {
    // guarantee that 'from' is absolute.
    from = path.resolve(from);

    // note: this approach *only* works when the path is guaranteed
    // to be absolute.  Doing a fully-edge-case-correct path.split
    // that works on both Windows and Posix is non-trivial.

    // return root node_modules when path is 'D:\\'.
    // path.resolve will make sure from.length >=3 in Windows.
    if (from.charCodeAt(from.length - 1) === 92/*\*/ &&
        from.charCodeAt(from.length - 2) === 58/*:*/)
      return [from + 'node_modules'];

    const paths = [];
    var p = 0;
    var last = from.length;
    for (var i = from.length - 1; i >= 0; --i) {
      const code = from.charCodeAt(i);
      // The path segment separator check ('\' and '/') was used to get
      // node_modules path for every path segment.
      // Use colon as an extra condition since we can get node_modules
      // path for dirver root like 'C:\node_modules' and don't need to
      // parse driver name.
      if (code === 92/*\*/ || code === 47/*/*/ || code === 58/*:*/) {
        if (p !== nmLen)
          paths.push(from.slice(0, last) + '\\node_modules');
        last = i;
        p = 0;
      } else if (p !== -1) {
        if (nmChars[p] === code) {
          ++p;
        } else {
          p = -1;
        }
      }
    }

    return paths;
  };
} else { // posix
  // 'from' is the __dirname of the module.
  Module._nodeModulePaths = function(from) {
    // guarantee that 'from' is absolute.
    from = path.resolve(from);
    // Return early not only to avoid unnecessary work, but to *avoid* returning
    // an array of two items for a root: [ '//node_modules', '/node_modules' ]
    if (from === '/')
      return ['/node_modules'];

    // note: this approach *only* works when the path is guaranteed
    // to be absolute.  Doing a fully-edge-case-correct path.split
    // that works on both Windows and Posix is non-trivial.
    const paths = [];
    var p = 0;
    var last = from.length;
    for (var i = from.length - 1; i >= 0; --i) {
      const code = from.charCodeAt(i);
      if (code === 47/*/*/) {
        if (p !== nmLen)
          paths.push(from.slice(0, last) + '/node_modules');
        last = i;
        p = 0;
      } else if (p !== -1) {
        if (nmChars[p] === code) {
          ++p;
        } else {
          p = -1;
        }
      }
    }

    // Append /node_modules to handle root paths.
    paths.push('/node_modules');

    return paths;
  };
}


// 'index.' character codes
var indexChars = [ 105, 110, 100, 101, 120, 46 ];
var indexLen = indexChars.length;
//用来查找模块，返回一个数组，数组第一项为模块名称即request，数组第二项返回一个可能包含这个模块的文件夹路径数组
//
//处理了如下几种情况：
// 1、是原生模块且不是内部模块
// 2、如果路径不以"./" 或者'..'开头或者只有一个字符串，即是引用模块名的方式，即require('moduleA'); 
// 3、父亲模块为空的情况
// 4、父亲模块是否为index模块，
Module._resolveLookupPaths = function(request, parent, newReturn) { //request 当前加载的模块名称,parent 父亲模块

  //NativeModule用于管理js模块，头部引入的。NativeModule.nonInternalExists()用来判断是否 是原生模块且不是内部模块，所谓内部模块就是指lib/internal 文件目录下的模块，像fs等。
  if (NativeModule.nonInternalExists(request)) { 
    debug('looking for %j in []', request); 

    //满足 是原生模块且不是内部模块，并且newReturn 为true，则返回null ，如果newReturn 为false 则返回［request, []］。
    return (newReturn ? null : [request, []]);
  }

  // Check for relative path
  // 检查相关路径 
  // 如果路径不以"./" 或者'..'开头或者只有一个字符串，即是引用模块名的方式，即require('moduleA');
  if (request.length < 2 ||
      request.charCodeAt(0) !== 46/*.*/ ||
      (request.charCodeAt(1) !== 46/*.*/ &&
       request.charCodeAt(1) !== 47/*/*/)) {
    var paths = modulePaths; //全局变量,在Module._initPaths 函数中赋值的变量,modulePaths记录了全局加载依赖的根目录

    // 设置一下父亲的路径，其实就是谁导入了当前模块
    if (parent) {
      if (!parent.paths)
        paths = parent.paths = [];
      else
        paths = parent.paths.concat(paths);
    }

    // Maintain backwards compat with certain broken uses of require('.')
    // by putting the module's directory in front of the lookup paths.
    // 如果只有一个字符串，且是 . 
    if (request === '.') {
      if (parent && parent.filename) {
        paths.unshift(path.dirname(parent.filename));
      } else {
        paths.unshift(path.resolve(request));
      }
    }

    debug('looking for %j in %j', request, paths);

    //直接返回
    return (newReturn ? (paths.length > 0 ? paths : null) : [request, paths]);
  }

  // with --eval, parent.id is not set and parent.filename is null
  // 处理父亲模块为空的情况
  if (!parent || !parent.id || !parent.filename) {
    // make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but with eval there is no filename
    // 生成新的目录， 在系统目录 modulePaths，当前目录 和 "node_modules" 作为候选的路径
    var mainPaths = ['.'].concat(Module._nodeModulePaths('.'), modulePaths);

    debug('looking for %j in %j', request, mainPaths);
    //直接返回
    return (newReturn ? mainPaths : [request, mainPaths]);
  }

  // Is the parent an index module?
  // We can assume the parent has a valid extension,
  // as it already has been accepted as a module.
  // 处理父亲模块是否为index模块，即 path/index.js 或者 X/index.json等 带有index字样的module
  const base = path.basename(parent.filename); // path.basename()返回路径中的最后一部分
  var parentIdPath;
  if (base.length > indexLen) {
    var i = 0;

    //检查 引入的模块名中是否有 "index." 字段，如果有, i === indexLen。
    for (; i < indexLen; ++i) {
      if (indexChars[i] !== base.charCodeAt(i))
        break;
    }

    // 匹配 "index." 成功，查看是否有多余字段以及剩余部分的匹配情况
    if (i === indexLen) {
      // We matched 'index.', let's validate the rest
      for (; i < base.length; ++i) {
        const code = base.charCodeAt(i);

        // 如果模块名中有  除了 _, 0-9,A-Z,a-z 的字符 则跳出循环
        if (code !== 95/*_*/ &&
            (code < 48/*0*/ || code > 57/*9*/) &&
            (code < 65/*A*/ || code > 90/*Z*/) &&
            (code < 97/*a*/ || code > 122/*z*/))
          break;
      }


      if (i === base.length) {
        // Is an index module
        parentIdPath = parent.id;
      } else {
        // Not an index module
        parentIdPath = path.dirname(parent.id); //path.dirname() 返回路径中代表文件夹的部分
      }
    } else {
      // Not an index module
      parentIdPath = path.dirname(parent.id);
    }
  } else {
    // Not an index module
    parentIdPath = path.dirname(parent.id);
  }

  //拼出绝对路径
  var id = path.resolve(parentIdPath, request);  //path.resolve([from ...], to) 将 to 参数解析为绝对路径。eg:path.resolve('/foo/bar', './baz')   输出'/foo/bar/baz'

  // make sure require('./path') and require('path') get distinct ids, even
  // when called from the toplevel js file
  // 确保require('./path')和require('path')两种形式的，获得不同的 ids
  if (parentIdPath === '.' && id.indexOf('/') === -1) {
    id = './' + id;
  }

  debug('RELATIVE: requested: %s set ID to: %s from %s', request, id,
        parent.id);

  var parentDir = [path.dirname(parent.filename)]; //path.dirname() 返回路径中代表文件夹的部分
  debug('looking for %j in %j', id, parentDir);

  // 当我们以"./" 等方式require时，都是以当前父模块为对象路径的
  return (newReturn ? parentDir : [id, parentDir]);
};


// Check the cache for the requested file.
// 1. If a module already exists in the cache: return its exports object.
// 2. If the module is native: call `NativeModule.require()` with the
//    filename and return the result.
// 3. Otherwise, create a new module for the file and save it to the cache.
//    Then have it load  the file contents before returning its exports
//    object.
// 从缓存中查找所要加载的模块
// 1. 如果一个模块已经存在于缓存中：直接返回它的exports对象
// 2. 如果模块是一个本地模块，调用'NativeModule.require()'方法，filename作为参数，并返回结果
// 3. 否则，使用这个文件创建一个新模块并把它加入缓存中。在加载它只会返回exports对象。
Module._load = function(request, parent, isMain) { //_load函数三个参数： path 当前加载的模块名称,parent 父亲模块，/* isMain */ false  是不是主入口文件
  if (parent) {
    debug('Module._load REQUEST %s parent: %s', request, parent.id); //头部引入了 Module._debug = util.debuglog('module');const debug = Module._debug;  这个方法用来打印出调试信息,具体可以看 https://chyingp.gitbooks.io/nodejs/%E6%A8%A1%E5%9D%97/util.html
  }


  //
  var filename = Module._resolveFilename(request, parent, isMain);

  var cachedModule = Module._cache[filename];
  if (cachedModule) {
    return cachedModule.exports;
  }

  if (NativeModule.nonInternalExists(filename)) {
    debug('load native module %s', request);
    return NativeModule.require(filename);
  }

  var module = new Module(filename, parent);

  if (isMain) {
    process.mainModule = module;
    module.id = '.';
  }

  Module._cache[filename] = module;

  tryModuleLoad(module, filename);

  return module.exports;
};

function tryModuleLoad(module, filename) {
  var threw = true;
  try {
    module.load(filename);
    threw = false;
  } finally {
    if (threw) {
      delete Module._cache[filename];
    }
  }
}

function getInspectorCallWrapper() {
  var inspector = process.inspector;
  if (!inspector || !inspector.callAndPauseOnStart) {
    return null;
  }
  var wrapper = inspector.callAndPauseOnStart.bind(inspector);
  delete inspector.callAndPauseOnStart;
  if (Object.keys(process.inspector).length === 0) {
    delete process.inspector;
  }
  return wrapper;
}

Module._resolveFilename = function(request, parent, isMain) { //request 当前加载的模块名称,parent 父亲模块，/* isMain */ false  是不是主入口文件

  //NativeModule用于管理js模块，头部引入的。NativeModule.nonInternalExists()用来判断是否 是原生模块且不是内部模块，所谓内部模块就是指lib/internal 文件目录下的模块，像fs等。满足 是原生模块且不是内部模块,则直接返回 当前加载的模块名称request。
  if (NativeModule.nonInternalExists(request)) { 
    return request;
  }

  // Module._resolveLookupPaths()函数返回一个数组[id , paths], paths是一个 可能 包含这个模块的文件夹路径(绝对路径)数组
  var paths = Module._resolveLookupPaths(request, parent, true);

  // look up the filename first, since that's the cache key.
  // 确定哪一个路径为真，缓存机制 
  var filename = Module._findPath(request, paths, isMain);

  // 如果没有找到模块，报错
  if (!filename) {
    var err = new Error(`Cannot find module '${request}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }

  // 找到模块则直接返回
  return filename;
};


// Given a file name, pass it to the proper extension handler.
Module.prototype.load = function(filename) {
  debug('load %j for module %j', filename, this.id);

  assert(!this.loaded);
  this.filename = filename;
  this.paths = Module._nodeModulePaths(path.dirname(filename));

  var extension = path.extname(filename) || '.js';
  if (!Module._extensions[extension]) extension = '.js';
  Module._extensions[extension](this, filename);
  this.loaded = true;
};


// Loads a module at the given file path. Returns that module's
// `exports` property.
Module.prototype.require = function(path) {
  assert(path, 'missing path');  //断言是否有path
  assert(typeof path === 'string', 'path must be a string'); //断言 path是否是个字符串
  return Module._load(path, this, /* isMain */ false);  //require方法主要是为了引出_load方法。_load函数三个参数： path 当前加载的模块名称,parent 父亲模块，其实是谁导入了该模块，/* isMain */ false  是不是主入口文件
};


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --debug-brk)
var resolvedArgv;


// Run the file contents in the correct scope or sandbox. Expose
// the correct helper variables (require, module, exports) to
// the file.
// Returns exception, if any.
Module.prototype._compile = function(content, filename) {
  // Remove shebang
  var contLen = content.length;
  if (contLen >= 2) {
    if (content.charCodeAt(0) === 35/*#*/ &&
        content.charCodeAt(1) === 33/*!*/) {
      if (contLen === 2) {
        // Exact match
        content = '';
      } else {
        // Find end of shebang line and slice it off
        var i = 2;
        for (; i < contLen; ++i) {
          var code = content.charCodeAt(i);
          if (code === 10/*\n*/ || code === 13/*\r*/)
            break;
        }
        if (i === contLen)
          content = '';
        else {
          // Note that this actually includes the newline character(s) in the
          // new output. This duplicates the behavior of the regular expression
          // that was previously used to replace the shebang line
          content = content.slice(i);
        }
      }
    }
  }

  // create wrapper function
  var wrapper = Module.wrap(content);

  var compiledWrapper = vm.runInThisContext(wrapper, {
    filename: filename,
    lineOffset: 0,
    displayErrors: true
  });

  var inspectorWrapper = null;
  if (process._debugWaitConnect && process._eval == null) {
    if (!resolvedArgv) {
      // we enter the repl if we're not given a filename argument.
      if (process.argv[1]) {
        resolvedArgv = Module._resolveFilename(process.argv[1], null, false);
      } else {
        resolvedArgv = 'repl';
      }
    }

    // Set breakpoint on module start
    if (filename === resolvedArgv) {
      delete process._debugWaitConnect;
      inspectorWrapper = getInspectorCallWrapper();
      if (!inspectorWrapper) {
        const Debug = vm.runInDebugContext('Debug');
        Debug.setBreakPoint(compiledWrapper, 0, 0);
      }
    }
  }
  var dirname = path.dirname(filename);
  var require = internalModule.makeRequireFunction(this);
  var depth = internalModule.requireDepth;
  if (depth === 0) stat.cache = new Map();
  var result;
  if (inspectorWrapper) {
    result = inspectorWrapper(compiledWrapper, this.exports, this.exports,
                              require, this, filename, dirname);
  } else {
    result = compiledWrapper.call(this.exports, this.exports, require, this,
                                  filename, dirname);
  }
  if (depth === 0) stat.cache = null;
  return result;
};


// 根据不同的文件类型，三种后缀，Node.js会进行不同的处理和执行
// 对于.js的文件会，先同步读取文件，然后通过module._compile解释执行。
// 对于.json文件的处理，先同步的读入文件的内容，无异常的话直接将模块的exports赋值为json文件的内容 
// 对于.node文件的打开处理，通常为C/C++文件。

// Native extension for .js
Module._extensions['.js'] = function(module, filename) {
  // 同步读取文件
  var content = fs.readFileSync(filename, 'utf8');

  // 通过module._compile解释执行
  module._compile(internalModule.stripBOM(content), filename);
};


// Native extension for .json
Module._extensions['.json'] = function(module, filename) {
  // 同步的读入文件的内容
  var content = fs.readFileSync(filename, 'utf8');
  try {
    // 直接将模块的exports赋值为json文件的内容
    module.exports = JSON.parse(internalModule.stripBOM(content));
  } catch (err) {
    // 异常处理
    err.message = filename + ': ' + err.message;
    throw err;
  }
};


//Native extension for .node
Module._extensions['.node'] = function(module, filename) {
  return process.dlopen(module, path._makeLong(filename));
};


// bootstrap main module.
Module.runMain = function() {
  // Load the main module--the command line argument.
  Module._load(process.argv[1], null, true);
  // Handle any nextTicks added in the first tick of the program
  process._tickCallback();
};

// 初始化全局的依赖加载路径 ，定义之后直接调用了。
Module._initPaths = function() {  
  const isWindows = process.platform === 'win32';

  var homeDir;
  if (isWindows) {
    homeDir = process.env.USERPROFILE;
  } else {
    homeDir = process.env.HOME;
  }

  // $PREFIX/lib/node, where $PREFIX is the root of the Node.js installation.
  var prefixDir;
  // process.execPath is $PREFIX/bin/node except on Windows where it is
  // $PREFIX\node.exe.
  if (isWindows) {
    prefixDir = path.resolve(process.execPath, '..');
  } else {
    prefixDir = path.resolve(process.execPath, '..', '..');
  }
  var paths = [path.resolve(prefixDir, 'lib', 'node')];

  if (homeDir) {
    paths.unshift(path.resolve(homeDir, '.node_libraries'));
    paths.unshift(path.resolve(homeDir, '.node_modules'));
  }

  //获取环境变量“NODE_PATH”
  var nodePath = process.env['NODE_PATH'];
  if (nodePath) {
    paths = nodePath.split(path.delimiter).filter(function(path) {
      return !!path;
    }).concat(paths);
  }
  // modulePaths记录了全局加载依赖的根目录,全局变量
  //   modulePaths = Module.globalPaths :
      // 1: $HOME/.node_modules
      // 2: $HOME/.node_libraries
      // 3: $PREFIX/lib/node
  modulePaths = paths;

  // clone as a shallow copy, for introspection.
  Module.globalPaths = modulePaths.slice(0);
};

Module._preloadModules = function(requests) {
  if (!Array.isArray(requests))
    return;

  // Preloaded modules have a dummy parent module which is deemed to exist
  // in the current working directory. This seeds the search path for
  // preloaded modules.
  var parent = new Module('internal/preload', null);
  try {
    parent.paths = Module._nodeModulePaths(process.cwd());
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  for (var n = 0; n < requests.length; n++)
    parent.require(requests[n]);
};

Module._initPaths();

// backwards compatibility
Module.Module = Module;
