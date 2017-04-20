// 可以尝试在终端 输入 node b.js 看打印结果

console.log('module.id: ', module.id);
console.log('module.exports: ', module.exports);
console.log('module.parent: ', module.parent);
console.log('module.filename: ', module.filename);
console.log('module.loaded: ', module.loaded);
console.log('module.children: ', module.children);
console.log('module.paths: ', module.paths);


(function(){
	var a = require('./a.js');
	console.log(a.name);
	console.log(a);



})()