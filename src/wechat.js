import { EventEmitter } from 'events';

/**
 * 统一的消息格式，无论来自 Mock 还是 WeChatFerry
 *
 * {
 *   wxid:      string   // 联系人的微信 ID
 *   name:      string   // 联系人显示名称
 *   content:   string   // 消息文本内容
 *   isSelf:    boolean  // true = 自己发的，false = 对方发的
 *   timestamp: number   // 毫秒时间戳
 *   type:      string   // 'text' | 'image' | ...（暂时只用 text）
 * }
 */

class WeChatClient extends EventEmitter {
  constructor() {
    super();
    this.started = false;
  }

  /**
   * 启动监听。
   * Mock 模式下什么都不做，消息通过 receive() 手动注入。
   * Windows 生产环境下在这里初始化 WeChatFerry。
   */
  start() {
    if (this.started) return;
    this.started = true;

    if (process.platform === 'win32') {
      this._startWeChatFerry();
    } else {
      console.log('[wechat] Mock 模式已启动，等待手动注入消息');
    }
  }

  stop() {
    if (process.platform === 'win32') {
      this._stopWeChatFerry();
    }
    this.started = false;
  }

  /**
   * Mock 模式：手动注入一条消息，触发 'message' 事件。
   * 由 server.js 的 REST 接口调用。
   *
   * @param {object} param
   * @param {string} param.wxid      联系人 wxid（Mock 下可自定义）
   * @param {string} param.name      联系人显示名称
   * @param {string} param.content   消息内容
   * @param {boolean} param.isSelf   是否是自己发的
   */
  receive({ wxid, name, content, isSelf = false }) {
    const msg = {
      wxid,
      name,
      content,
      isSelf,
      timestamp: Date.now(),
      type: 'text',
    };
    this.emit('message', msg);
    return msg;
  }

  // ── WeChatFerry 接口预留（仅 Windows） ──────────────────────

  _startWeChatFerry() {
    // TODO: Windows 环境下接入 WeChatFerry
    //
    // import { Wcf } from 'wcferry';
    // this.wcf = new Wcf();
    // this.wcf.start();
    //
    // this.wcf.on('message', (rawMsg) => {
    //   if (rawMsg.type !== 1) return; // 只处理文本消息
    //
    //   const contact = this.wcf.getContact(rawMsg.sender);
    //   this.emit('message', {
    //     wxid:      rawMsg.sender,
    //     name:      contact?.name ?? rawMsg.sender,
    //     content:   rawMsg.content,
    //     isSelf:    rawMsg.isSelf,
    //     timestamp: rawMsg.ts * 1000,
    //     type:      'text',
    //   });
    // });
    //
    // console.log('[wechat] WeChatFerry 已启动');

    console.warn('[wechat] WeChatFerry 接口尚未实现，当前运行在 Mock 模式');
  }

  _stopWeChatFerry() {
    // TODO: this.wcf?.stop();
  }
}

export default new WeChatClient();
