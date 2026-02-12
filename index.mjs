/**
 * NapCat MQTT 插件
 * 功能：连接 MQTT broker，订阅/发布消息
 * 包含连接管理、消息收发、事件处理等功能
 */

import mqtt from 'mqtt';


// 当前连接的Broker URL
let currentBrokerUrl = '';

// MQTT 客户端实例，初始值为null
let client = null;

// 全局上下文，用于在MQTT消息回调中发送消息
let globalCtx = null;

/**
 * Topic到用户的映射，记录哪些用户订阅了哪些主题
 * @type {Map<string, Set<string>>} topic -> Set(userId)
 */
const topicToUsers = new Map();

/**
 * 用户上下文管理
 * 为每个私聊用户维护独立的MQTT操作状态，实现用户间隔离
 * @type {Map<string, {userId: string, subscribedTopics: Set<string>, lastCommand: string, commandTime: number}>}
 */
const userContextMap = new Map();

/**
 * 获取或初始化用户的上下文
 * @param {string} userId - 用户ID
 * @returns {Object} 用户的上下文对象
 */
function getUserContext(userId) {
  if (!userContextMap.has(userId)) {
    userContextMap.set(userId, {
      userId: userId,
      subscribedTopics: new Set(),
      lastCommand: '',
      commandTime: 0,
      operationCount: 0
    });
  }
  return userContextMap.get(userId);
}

/**
 * 清理用户上下文（用户长时间不活动时）
 * @param {string} userId - 用户ID
 */
function clearUserContext(userId) {
  if (userContextMap.has(userId)) {
    userContextMap.delete(userId);
  }
}

/**
 * 获取插件配置
 * 在插件初始化时调用
 * @param {Object} ctx - 上下文对象
 */
const plugin_get_config = async (ctx) => {
  ctx.logger.log('触发plugin_get_config');
};

/**
 * 设置MQTT客户端事件监听器
 */
function setupMQTTEventListeners(ctx) {
  // 处理连接成功事件
  client.on('connect', () => {
    ctx.logger.log('成功连接到MQTT服务器');
  });
}

/**
 * 处理MQTT消息并转发给订阅的用户
 * @param {string} topic - 消息主题
 * @param {Buffer} messageBuffer - 消息内容
 */
async function handleMQTTMessage(topic, messageBuffer) {
  if (!globalCtx) {
    return;
  }

  try {
    const messageStr = messageBuffer.toString();
    globalCtx.logger.info(`[MQTT] 收到消息 [${topic}]: ${messageStr}`);

    // 查找订阅了该主题的所有用户
    if (!topicToUsers.has(topic)) {
      globalCtx.logger.info(`[MQTT] 主题 ${topic} 没有订阅者`);
      return;
    }

    const userIds = topicToUsers.get(topic);
    
    // 为每个订阅了该主题的用户发送私聊消息
    for (const userId of userIds) {
      try {
        const sendParams = {
          message: `📨 [${topic}]:\n${messageStr}`,
          message_type: 'private',
          user_id: userId,
        };

        await globalCtx.actions.call('send_msg', sendParams, globalCtx.adapterName, globalCtx.pluginManager.config);
        globalCtx.logger.info(`[MQTT] 已转发消息给用户 ${userId}`);
      } catch (error) {
        globalCtx.logger.error(`[MQTT] 转发消息给用户 ${userId} 失败:`, error);
      }
    }
  } catch (error) {
    globalCtx.logger.error('[MQTT] 处理消息时出错:', error);
  }
}

/**
 * 插件初始化函数
 * @param {Object} ctx - 上下文对象，包含logger等功能
 */
const plugin_init = async (ctx) => {
  globalCtx = ctx;
  ctx.logger.info('MQTT插件加载完成，使用 #mqtt connect 连接到服务器');
};

/**
 * 配置变更事件回调
 * 当插件配置发生变化时触发
 * @param {Object} ctx - 上下文对象
 */
const plugin_on_config_change = async (ctx) => {
  ctx.logger.log('触发plugin_on_config_change');
};

/**
 * 消息事件回调
 * 接收到相关消息时触发
 * @param {Object} ctx - 上下文对象
 * @param {Object} event - 消息事件对象
 */
const plugin_onmessage = async (ctx, event) => {
  try {
    // 检查是否为消息类型事件
    if (event.post_type !== 'message') {
      return;
    }

    // 只处理私聊消息
    if (event.message_type !== 'private') {
      return;
    }

    const userId = String(event.user_id);
    const userContext = getUserContext(userId);

    // 获取消息内容
    let messageContent = '';
    
    // 如果是字符串消息，直接使用
    if (typeof event.message === 'string') {
      messageContent = event.message;
    } 
    // 如果是消息数组（CQ码格式），提取文本和纯文本CQ码
    else if (Array.isArray(event.message)) {
      messageContent = event.message
        .map(msg => {
          if (msg.type === 'text') {
            return msg.data?.text || '';
          }
          return '';
        })
        .join('')
        .trim();
    }

    // 检查消息是否以 #mqtt 开头
    if (!messageContent.startsWith('#mqtt')) {
      return;
    }

    ctx.logger.info(`收到MQTT指令: ${messageContent}`);

    // 解析指令参数
    const parts = messageContent.split(/\s+/);
    const command = parts[1]; // 第一个参数是指令
    const args = parts.slice(2); // 其余参数

    let responseMessage = '';

    // 处理不同的MQTT指令
    switch (command) {
      case 'connect': {
        // 连接到MQTT服务器
        // 格式: #mqtt connect <broker_url> [username] [password]
        // 例如: #mqtt connect mqtt://mqtt.example.com:1883 user pass
        
        if (client && client.connected) {
          responseMessage = '⚠️ 已经连接到MQTT服务器，请勿重复连接';
          break;
        }

        if (args.length === 0) {
          responseMessage = '❌ 连接失败: 格式错误\n用法: #mqtt connect <broker_url> [username] [password]\n' +
            '示例: #mqtt connect mqtt://mqtt.example.com:1883 user password';
          break;
        }

        const brokerUrlInput = args[0];
        const usernameInput = args[1] || '';
        const passwordInput = args[2] || '';

        // 验证broker URL格式
        if (!brokerUrlInput.startsWith('mqtt://') && !brokerUrlInput.startsWith('mqtts://')) {
          responseMessage = '❌ 连接失败: Broker URL格式错误\n' +
            '应以 mqtt:// 或 mqtts:// 开头\n' +
            '示例: mqtt://mqtt.example.com:1883';
          break;
        }

        try {
          // 创建连接选项
          const connectOptions = {
            clientId: 'napcatmqtt_' + Math.random().toString(16).substr(2, 8),
            clean: true,
            reconnectPeriod: 0,
            connectTimeout: 30 * 1000,
          };

          // 如果提供了用户名和密码
          if (usernameInput) {
            connectOptions.username = usernameInput;
          }
          if (passwordInput) {
            connectOptions.password = passwordInput;
          }

          // 创建新的客户端连接
          if (client) {
            client.end(false);
          }

          client = mqtt.connect(brokerUrlInput, connectOptions);
          currentBrokerUrl = brokerUrlInput;
          // setupMQTTEventListeners(ctx);
          // 处理连接成功事件
          client.on('connect', () => {
            ctx.logger.log('成功连接到MQTT服务器');
          });

          // 监听消息接收事件
          client.on('message', (topic, message) => {
            handleMQTTMessage(topic, message);
          });

          // 监听错误事件
          client.on('error', (error) => {
            ctx.logger.error('MQTT错误:', error);
          });

          // 监听连接关闭事件
          client.on('close', () => {
            ctx.logger.info('连接已断开');
          });

          // 监听重连事件
          client.on('reconnect', () => {
            ctx.logger.info('正在重新连接...');
          });
          userContext.lastCommand = 'connect';
          userContext.commandTime = Date.now();
          userContext.operationCount++;

          responseMessage = `✅ 正在连接到MQTT服务器...\n` +
            `Broker: ${brokerUrlInput}\n` +
            `${usernameInput ? `用户名: ${usernameInput}` : '无认证信息'}`;
        } catch (error) {
          ctx.logger.error('创建MQTT连接时出错:', error);
          responseMessage = `❌ 连接失败: ${error.message}`;
        }
        break;
      }

      case 'disconnect': {
        // 断开MQTT服务器连接
        if (!client || !client.connected) {
          responseMessage = '⚠️ MQTT服务器未连接或已断开';
          break;
        }

        client.end(false, () => {
          ctx.logger.info('MQTT连接已断开');
        });

        currentBrokerUrl = '';
        // 清空topic到用户的映射
        topicToUsers.clear();
        
        userContext.lastCommand = 'disconnect';
        userContext.commandTime = Date.now();
        userContext.operationCount++;

        responseMessage = `✅ 已断开MQTT服务器连接`;
        break;
      }

      case 'publish': {
        // 格式: #mqtt publish <topic> <message...>
        
        // 检查连接状态
        if (!client || !client.connected) {
          responseMessage = '❌ MQTT服务器未连接，请先使用 #mqtt connect 连接';
          break;
        }

        if (args.length < 2) {
          responseMessage = '❌ 发布失败: 格式错误\n用法: #mqtt publish <主题> <消息>';
          break;
        }

        const topic = args[0];
        const message = args.slice(1).join(' ');

        client.publish(topic, message, { qos: 0, retain: false }, (err) => {
          if (err) {
            ctx.logger.error(`[用户${userId}] 发布到主题 ${topic} 失败:`, err);
          } else {
            ctx.logger.info(`[用户${userId}] 成功发布消息到主题 ${topic}`);
          }
        });

        userContext.lastCommand = `publish ${topic}`;
        userContext.commandTime = Date.now();
        userContext.operationCount++;

        responseMessage = `✅ 消息已发布到主题: ${topic}\n内容: ${message}\n[用户私有操作]`;
        break;
      }

      case 'subscribe': {
        // 格式: #mqtt subscribe <topic>
        
        // 检查连接状态
        if (!client || !client.connected) {
          responseMessage = '❌ MQTT服务器未连接，请先使用 #mqtt connect 连接';
          break;
        }

        if (args.length === 0) {
          responseMessage = '❌ 订阅失败: 格式错误\n用法: #mqtt subscribe <主题>';
          break;
        }

        const topic = args[0];

        // 检查用户是否已订阅该主题
        if (userContext.subscribedTopics.has(topic)) {
          responseMessage = `⚠️ 您已订阅过主题: ${topic}`;
          break;
        }

        client.subscribe(topic, { qos: 0 }, (error, granted) => {
          if (error) {
            ctx.logger.error(`[用户${userId}] 订阅主题 ${topic} 失败:`, error);
          } else {
            userContext.subscribedTopics.add(topic);
            
            // 更新topic到用户的映射
            if (!topicToUsers.has(topic)) {
              topicToUsers.set(topic, new Set());
            }
            topicToUsers.get(topic).add(userId);
            
            ctx.logger.info(`[用户${userId}] 成功订阅主题: ${granted[0].topic}`);
          }
        });

        userContext.lastCommand = `subscribe ${topic}`;
        userContext.commandTime = Date.now();
        userContext.operationCount++;

        responseMessage = `✅ 已订阅主题: ${topic}\n已订阅主题总数: ${userContext.subscribedTopics.size + 1}`;
        break;
      }

      case 'unsubscribe': {
        // 格式: #mqtt unsubscribe <topic>
        
        // 检查连接状态
        if (!client || !client.connected) {
          responseMessage = '❌ MQTT服务器未连接，请先使用 #mqtt connect 连接';
          break;
        }

        if (args.length === 0) {
          responseMessage = '❌ 取消订阅失败: 格式错误\n用法: #mqtt unsubscribe <主题>';
          break;
        }

        const topic = args[0];

        // 检查用户是否订阅了该主题
        if (!userContext.subscribedTopics.has(topic)) {
          responseMessage = `⚠️ 您未订阅该主题: ${topic}`;
          break;
        }

        client.unsubscribe(topic, (error) => {
          if (error) {
            ctx.logger.error(`[用户${userId}] 取消订阅主题 ${topic} 失败:`, error);
          } else {
            userContext.subscribedTopics.delete(topic);
            
            // 从topic到用户的映射中删除该用户
            if (topicToUsers.has(topic)) {
              topicToUsers.get(topic).delete(userId);
              // 如果没有用户订阅该主题了，删除该主题的记录
              if (topicToUsers.get(topic).size === 0) {
                topicToUsers.delete(topic);
              }
            }
            
            ctx.logger.info(`[用户${userId}] 成功取消订阅主题: ${topic}`);
          }
        });

        userContext.lastCommand = `unsubscribe ${topic}`;
        userContext.commandTime = Date.now();
        userContext.operationCount++;

        responseMessage = `✅ 已取消订阅主题: ${topic}\n已订阅主题总数: ${userContext.subscribedTopics.size - 1}`;
        break;
      }

      case 'status': {
        // 显示连接状态
        const status = client && client.connected ? '✅ 已连接' : '❌ 未连接';
        const topicList = userContext.subscribedTopics.size > 0 
          ? Array.from(userContext.subscribedTopics).join('\n  • ') 
          : '(无)';
        
        responseMessage = `📊 MQTT状态:\n` +
          `连接状态: ${status}\n` +
          `Broker: ${currentBrokerUrl || '未设置'}\n` +
          `您的已订阅主题: ${userContext.subscribedTopics.size}\n  • ${topicList}\n` +
          `您的操作统计: ${userContext.operationCount} 次`;
        break;
      }

      case 'help': {
        // 显示帮助信息
        responseMessage = `📋 MQTT指令列表 (仅限私聊):\n` +
          `#mqtt connect <broker_url> [username] [password] - 连接到MQTT服务器\n` +
          `#mqtt disconnect - 断开MQTT服务器连接\n` +
          `#mqtt publish <主题> <消息> - 发布消息到MQTT主题\n` +
          `#mqtt subscribe <主题> - 订阅MQTT主题\n` +
          `#mqtt unsubscribe <主题> - 取消订阅MQTT主题\n` +
          `#mqtt status - 查看MQTT连接状态和您的订阅情况\n` +
          `#mqtt list - 列出您订阅的所有主题\n` +
          `#mqtt clear - 清空您的所有订阅\n` +
          `#mqtt help - 显示此帮助信息\n\n` +
          `📝 使用示例:\n` +
          `无认证: #mqtt connect mqtt://mqtt.example.com:1883\n` +
          `带认证: #mqtt connect mqtt://mqtt.example.com:1883 username password\n\n` +
          `💡 说明: 每个用户拥有独立的MQTT操作上下文，不同用户间操作互不影响。`;
        break;
      }

      case 'list': {
        // 列出用户订阅的所有主题
        if (userContext.subscribedTopics.size === 0) {
          responseMessage = '📌 您还未订阅任何主题';
        } else {
          const topicList = Array.from(userContext.subscribedTopics)
            .map((topic, index) => `${index + 1}. ${topic}`)
            .join('\n');
          responseMessage = `📌 您订阅的主题列表 (共 ${userContext.subscribedTopics.size} 个):\n${topicList}`;
        }
        break;
      }

      case 'clear': {
        // 清空用户的所有订阅
        
        // 检查连接状态
        if (!client || !client.connected) {
          responseMessage = '❌ MQTT服务器未连接，请先使用 #mqtt connect 连接';
          break;
        }

        if (userContext.subscribedTopics.size === 0) {
          responseMessage = '⚠️ 您还未订阅任何主题';
          break;
        }

        const topicsToUnsubscribe = Array.from(userContext.subscribedTopics);
        const unsubscribePromises = topicsToUnsubscribe.map(topic => 
          new Promise((resolve) => {
            client.unsubscribe(topic, (error) => {
              if (!error) {
                userContext.subscribedTopics.delete(topic);
                
                // 从topic到用户的映射中删除该用户
                if (topicToUsers.has(topic)) {
                  topicToUsers.get(topic).delete(userId);
                  // 如果没有用户订阅该主题了，删除该主题的记录
                  if (topicToUsers.get(topic).size === 0) {
                    topicToUsers.delete(topic);
                  }
                }
              }
              resolve();
            });
          })
        );

        await Promise.all(unsubscribePromises);

        userContext.lastCommand = 'clear';
        userContext.commandTime = Date.now();
        userContext.operationCount++;

        responseMessage = `✅ 已清空所有订阅 (清除了 ${topicsToUnsubscribe.length} 个主题)`;
        break;
      }

      default: {
        responseMessage = `❌ 未知指令: ${command}\n输入 #mqtt help 查看可用指令`;
      }
    }

    // 发送响应消息
    if (responseMessage) {
      try {
        const sendParams = {
          message: responseMessage,
          message_type: event.message_type, // 保持原消息类型（group 或 private）
        };

        // 根据消息类型添加对应的ID
        if (event.message_type === 'group') {
          sendParams.group_id = String(event.group_id);
        } else if (event.message_type === 'private') {
          sendParams.user_id = String(event.user_id);
        }

        await ctx.actions.call('send_msg', sendParams, ctx.adapterName, ctx.pluginManager.config);
        ctx.logger.info('MQTT指令响应已发送');
      } catch (error) {
        ctx.logger.error('发送响应消息失败:', error);
      }
    }
  } catch (error) {
    ctx.logger.error('处理消息时出错:', error);
  }
};

/**
 * 插件清理函数
 * 插件卸载时调用，负责关闭MQTT连接和资源释放
 * @param {Object} ctx - 上下文对象
 */
const plugin_cleanup = async (ctx) => {
  ctx.logger.log('触发plugin_cleanup');
  try {
    // 清理用户上下文
    userContextMap.clear();
    
    // 清空topic到用户的映射
    topicToUsers.clear();
    
    // 清空broker URL
    currentBrokerUrl = '';
    
    // 优雅地关闭MQTT客户端
    if (client && client.connected) {
      ctx.logger.info('正在关闭MQTT连接...');
      client.end(false, () => {
        ctx.logger.info('MQTT连接已关闭');
      });
    }
    ctx.logger.info("info", "插件已卸载");
  } catch (e) {
    // 捕获卸载过程中的异常
    ctx.logger.warn("warn", "插件卸载时出错:", e);
  }
};

/**
 * 事件处理回调
 * 处理系统事件
 * @param {Object} ctx - 上下文对象
 * @param {Object} event - 事件对象
 */
const plugin_onevent = async (ctx, event) => {
  ctx.logger.log('触发plugin_onevent');
};

// 导出所有插件接口函数
export {
  plugin_cleanup,        // 插件清理
  plugin_init,           // 插件初始化
  plugin_get_config,     // 获取配置
  plugin_on_config_change, // 配置变更
  plugin_onmessage,      // 消息处理
  plugin_onevent         // 事件处理
};