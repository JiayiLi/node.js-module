# node.js实现模块化源码学习
> Everyday , it gets a little easier .

阅读入口：node-module/lib/module.js 的 **require**  方法开始，每一行的阅读。

--------

### 前提知识
-  **知识点一**：主入口文件 即主模块。在 require 方法中引用的 Module._load(path,parent,isMain)，第三个参数 isMain 表示是不是主入口文件。对于 foo.js 文件，如果通过 node foo.js 运行则为 true，但如果通过 require('./foo') 运行则为 false。
正在完善中 (´･_･`)
-  **知识点二**：涉及到的模块类型:
　　　　　1、核心模块：指的 lib 目录下排除 lib/internal 文件下的模块。是那些被编译进 Node 的二进制模块，它们被预置在 Node 中，提供 Node 的基本功能，如fs、http、https等。核心模块使用 C/C++ 实现，外部使用 JS 封装。要加载核心模块，直接在代码文件中使用 require() 方法即可，参数为模块名称，Node 将自动从核心模块文件夹中进行加载。注意加载核心模块只能用模块名。核心模块拥有最高的加载优先级，即使已经有了一个同名的第三方模块，核心模块也会被优先加载。
　　　　　2、内部模块：指的是 lib/internal 文件夹下的模块，这些模块仅仅供 Node.js 核心的内部使用，不能被外部使用，可以随时被官方修改。


### CommonJS

node 模块属于 CommonJS 规范，采用同步加载模块的方式，也就是说只有加载完成，才能执行后面的操作。

它使用 require 引用和加载模块，exports 定义和导出模块，module 标识模块。使用 require 时需要去读取并执行该文件，然后返回 exports 导出的内容。


栗子：
``` javascript
//定义模块 math.js
 var random=Math.random()*10;
 function printRandom(){
     console.log(random)
 }

 function printIntRandom(){
     console.log(Math.floor(random))
 }
 //模块输出
 module.exports={
     printRandom:printRandom,
     printIntRandom:printIntRandom
 }
 //加载模块 math.js
 var math=require('math')
 //调用模块提供的方法
 math.printIntRandom()
 math.printRandom()
```

PS：由于 Node.js 主要用于服务器编程，模块文件一般都已经存在于本地硬盘，所以加载起来比较快，不用考虑非同步加载的方式，所以 CommonJS 规范比较适用。但是，如果是浏览器环境，要从服务器端加载模块，这时就必须采用非同步模式，因此浏览器端一般采用 AMD 规范。 


### node 模块实现

require 一个模块之后，有如下图几个重要的方法，被先后调用
![函数调用](./Module.prototype.require.png)

查找路径顺序：
![Alt text](./903320-20170420141719274-1325161899.png)


**建议：** 参照上面两图理清思路。
 
###  详细文章梳理
我同时也将自己所学的梳理成了文章，其中也介绍了其它的几个模块规范，以及之间的区别，在这里就不赘述了，大家可以看着文章从规范开始学习。
[【 js 模块加载 】深入学习模块化加载（node.js 模块源码）](http://www.cnblogs.com/lijiayi/p/js_node_module.html) 


--------


###  advice
- 邮箱：<jiayi_li10@163.com>
