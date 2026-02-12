# NapCat MQTT 插件

基于 [index.mjs](index.mjs) 的 NapCat 插件，实现通过 MQTT broker 的连接、订阅、发布与消息转发。

主要功能：
- 使用私聊命令管理 MQTT 连接（每个用户独立上下文）
- 在用户订阅的主题收到消息时，将消息以私聊方式转发给订阅该主题的用户
- 支持发布、订阅、取消订阅、列表、状态查询、清空等常用操作

> 注意：仓库中的 `index.mjs` 包含示例默认值（例如 `brokerUrl`、`username`、`password`），上线或公开使用前请务必替换为安全的配置。

## 快速使用

在 NapCat 中安装或部署本插件后，使用私聊向机器人发送以 `#mqtt` 开头的命令进行操作。插件仅响应私聊命令。

命令列表（私聊）：

- `#mqtt connect <broker_url> [username] [password]`
    - 连接到指定的 MQTT Broker（支持 `mqtt://` 和 `mqtts://`）。
    - 示例：`#mqtt connect mqtt://mqtt.example.com:1883` 或 `#mqtt connect mqtt://mqtt.example.com:1883 user password`

- `#mqtt disconnect`
    - 断开当前 MQTT 连接，并清空订阅映射。

- `#mqtt publish <topic> <message>`
    - 向指定主题发布消息，示例：`#mqtt publish sensors/room1 温度:24℃`

- `#mqtt subscribe <topic>`
    - 订阅主题，后续该主题的消息会转发给订阅此主题的用户（私聊）。

- `#mqtt unsubscribe <topic>`
    - 取消订阅主题。

- `#mqtt status`
    - 显示当前连接状态、Broker 地址、用户已订阅主题以及操作统计。

- `#mqtt list`
    - 列出您当前订阅的所有主题。

- `#mqtt clear`
    - 取消并清空您所有的订阅（逐主题退订）。

- `#mqtt help`
    - 显示帮助信息。

实现说明：
- 每个私聊用户维护独立的上下文（`userContextMap`），包含已订阅主题集合和操作统计，用户间操作互不影响。
- 插件维护 `topicToUsers` 映射（topic -> Set(userId)），当 MQTT 收到消息时，会遍历订阅该 topic 的用户并通过 OneBot 的 `send_msg` 将消息以私聊形式转发给用户。
- 插件导出并实现了 NapCat 生命周期函数：`plugin_init`, `plugin_onmessage`, `plugin_onevent`, `plugin_get_config`, `plugin_on_config_change`, `plugin_cleanup`。

默认示例（请根据实际情况修改）:
- 示例 Broker 地址（源码示例）: `mqtt://mqtt.example.com:1883`
- 示例用户名: `user`
- 示例密码: `password`

安全提示：
- 强烈建议不要在公开仓库中保留真实的用户名/密码或明文凭据。
- 在生产环境中，使用安全的凭据管理或 NapCat 提供的配置系统来注入敏感信息。

部署说明

- 直接将本仓库打包或将 `index.mjs` 放入 NapCat 的插件目录，或按 NapCat 插件规范将构建产物放到 `dist/`（如适用）。
- 插件卸载或重载时会调用 `plugin_cleanup`，该函数负责清理连接和内存数据。

开发者提示

- `index.mjs` 的关键变量：
    - `client`：MQTT 客户端实例
    - `currentBrokerUrl`：当前连接的 Broker 地址
    - `topicToUsers`：主题到用户集合的映射
    - `userContextMap`：每个用户的操作上下文

- 当需要扩展功能时建议：
    1. 将凭据和 Broker 地址通过 NapCat 配置系统注入（不要硬编码）
    2. 添加权限校验或操作限流以防滥用
    3. 根据实际场景选择合适的 QoS 与 retained 配置

联系我们 / 贡献

欢迎提交 issue 或 PR，提出改进建议或修复安全问题。

许可证

MIT
