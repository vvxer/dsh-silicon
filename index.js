// 运行入口：编译产物 lib/ 不进仓库，按 git 仓库校验插件的目录站要求 package.json 的 main 指向一个已提交的文件，所以留这一层转发。
export * from "./lib/index.js";
