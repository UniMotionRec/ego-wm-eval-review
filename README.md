# Ego WM 盲审工作台

团队使用这个页面比较一段人类示范和对应的机器人回放，独立判定任务是否完成、接触方式是否符合、动作过程是否一致。

[打开工作台](https://unimotionrec.github.io/ego-wm-eval-review/)

## 审阅

1. 打开工作台，首页直接载入六条开发样例。输入你的审阅编号，例如 GitHub 用户名。
2. 用同步播放和速度按钮查看视频，填写三个判断。依据可以点选或自行填写。能判断时用「记时间」引用当前回放时间。证据缺失时选「无法判断」并说明原因。
3. 点击「完成并下一条」。完成后导出 JSONL，交回组织者。草稿保存在当前浏览器，刷新首页可继续。

「审阅说明」里可以切换到合成练习，或选择其他批次的 ZIP、解压目录。

## 接入评估流水线

导出盲审素材后，用 [打包工具](scripts/README.md) 生成可导入的 ZIP。素材带随机案例编号、任务说明、视频和时间证据。组织者单独保管案例编号映射，两名审阅者分别完成后再合并导出的 JSONL。有分歧时，用下方命令打包需要复核的案例。复核包沿用原编号，第三名审阅者只需处理有分歧的判断项。

```bash
python3 scripts/prepare_arbitration.py --bundle review.zip --labels r1.jsonl r2.jsonl --out arbiter.zip
```

页面公开部署，首页的六条开发样例附有[示范来源和许可证](docs/review/ATTRIBUTION.md)。其他批次的导入和标注草稿由浏览器本地处理。

## 本地开发

用 `python3 -m http.server 8794 --directory docs` 启动，在浏览器打开 `http://localhost:8794`。页面无需构建步骤。GitHub Pages 的发布源为 `main:/docs`。

代码使用 [MIT License](LICENSE)。
