# dsh-eyes

给官方 **DeepSeek-V4-Flash** 和 **DeepSeek-V4-Pro** 补眼睛。选这两个官方模型里的任意一个，就可以贴图。

官方 DeepSeek 本身是纯文本。插件会：

1. 让这两个官方模型对外声明支持 image，Composer 贴图不会再被 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拦住。
2. 在发给 DeepSeek 之前，把图交给看图后端写成文字。
3. **只把文字**转给 `deepseek-official`，绝不把 `ImageBlock` 送进去。

看图默认走本机已经登录的 `grok`。也可以换成 `claude`、`codex`，或 xAI / OpenAI / 通义的 HTTP 接口。

另外三个工具：`see_image`、`ocr_image`、`locate_in_image`，一律返回文字。

不要把 key 写进插件。本机 CLI 用你已经登录的 grok / Claude Code / Codex，不会去翻它们的登录文件。

## 会不会换掉 DeepSeek

不会。界面上选的官方 Flash / Pro，就是在聊天的那个。设置里的 grok、Qwen、硅基流动这些，只负责看图，把图写成字。只打字、不贴图的时候，看图后端根本不会被叫到。模型名字没变，底下也没有偷梁换柱。

## 按图写网页

可以。贴一张设计稿或截图，对官方 Pro 说「按这个样子写个网页」。眼睛先把布局、颜色、上面的字写成一段话，Pro 根据这段话写 HTML。会像，很难像素级一模一样。图越清楚、你越说清「照着还原」，效果越好。

## 安装 / 卸载

```sh
dsh plugin --profile web add https://github.com/losebird/dsh-eyes
# 或本地：dsh plugin --profile web add /workspace/dsh-plugins/dsh-eyes
dsh --profile web --dump-config
```

改完 Host 后重启：`dsh --profile web --host 127.0.0.1 --port 3080`

```sh
dsh plugin --profile web remove dsh-eyes
```

## 看图用谁

打开设置 → **看图**，选后端，点保存。立刻生效，不用改 yaml。

默认 `backend: grok-cli`（本机 `grok` 命令）。

| backend | 怎么看图 |
| --- | --- |
| `grok-cli` | 本机 `grok`（已 login 即可） |
| `claude-cli` | 本机 `claude` |
| `codex-cli` | 本机 `codex` |
| `xai` / `openai` / `qwen` | HTTP 接口 + `apiKeyEnv` |
| `custom` | 自己填 `baseURL` + `model`，本机 Ollama 可以不配钥匙 |

可选：`cliPath`（命令不在 PATH 时）、`cliModel`（CLI 用哪个模型，grok 走 `-m`）。

设置页会把选择写到 `~/.dsh/dsh-eyes.json`（权限 0600）。钥匙只写环境变量或 `~/.dsh/.credentials.yaml`，不要写进插件或这个 json。

本机接口加了门：别的网站不能改后端；`cliPath` 只能指向 grok / claude / codex；本机 grok 看图不再带 `--always-approve`。

## 怎么验证

1. 重启后打开 `http://127.0.0.1:3080`。
2. 模型选官方 **DeepSeek-V4-Pro** 或 **Flash**。没有单独的「DeepSeek + Eyes」组。
3. 贴一张图发送。本机要能跑 `grok`（或你改的那个 CLI / API）。
4. 需要精细再看时可以说「看看这是什么」→ `see_image`。

## 图以外的文件

发送框左边有 **文件** 按钮。PDF、视频、Word / Excel / PPT 选上去（也可以拖进窗口），原文件落到 `~/.dsh/dsh-eyes-inbox/`，路径写进发送框。发送后模型调 `see_file`。图片仍直接粘贴。

- PDF：先打成页图再看（本机 `pdftoppm`），文字层也会抽出来。
- 视频：抽几帧再看（本机 `ffmpeg`）。现在不听声音。
- Office：抽出文字和里面嵌的图。没有把页面画成图的程序时，版式看不清。

设置页可改「PDF 最多看几页」「视频最多抽几帧」。
