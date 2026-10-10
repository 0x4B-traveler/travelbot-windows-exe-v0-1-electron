import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { MailSender, MailServer } from '../application/ports';

// 最小的 SMTP 客户端：只用来发提醒邮件（纯文本、UTF-8），不引入第三方依赖。
// 支持 465（SSL 直连）和 587 / 25（STARTTLS），AUTH LOGIN 登录。企业邮箱、QQ 邮箱、163 邮箱都是这套流程。

type Reply = { code: number; text: string };

class SmtpConnection {
  private buffer = '';
  private waiting: Array<(reply: Reply) => void> = [];
  private replies: Reply[] = [];
  private failure: Error | null = null;

  constructor(private socket: Socket | TLSSocket) { this.attach(socket); }

  private attach(socket: Socket | TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('邮件服务器断开了连接')));
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    // 一条回复可能有多行（250-xxx），最后一行是“代码 + 空格”
    let match: RegExpExecArray | null;
    while ((match = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const text = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      const reply = { code: Number(match[2]), text };
      const next = this.waiting.shift();
      if (next) next(reply); else this.replies.push(reply);
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiting.splice(0)) waiter({ code: 0, text: error.message });
  }

  read(): Promise<Reply> {
    const ready = this.replies.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.resolve({ code: 0, text: this.failure.message });
    return new Promise(resolve => this.waiting.push(resolve));
  }

  async command(line: string | null, expect: number[], what: string): Promise<Reply> {
    if (line !== null) this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expect.includes(reply.code)) throw new Error(`${what}失败：${reply.text || '没有响应'}`);
    return reply;
  }

  /** STARTTLS 后把连接升级成加密连接。 */
  async upgrade(host: string) {
    this.socket.removeAllListeners('data'); this.socket.removeAllListeners('close'); this.socket.removeAllListeners('error');
    const secure = tlsConnect({ socket: this.socket, servername: host });
    await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    this.socket = secure;
    this.attach(secure);
  }

  close() { try { this.socket.write('QUIT\r\n'); this.socket.end(); } catch { /* 已断开 */ } }
}

const encodeWord = (text: string) => `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
const wrap76 = (base64: string) => base64.replace(/.{1,76}/g, line => `${line}\r\n`);

export class SmtpMailSender implements MailSender {
  async send(server: MailServer, mail: { to: string[]; subject: string; text: string }): Promise<void> {
    const timeoutMs = 20000;
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const options = { host: server.host, port: server.port };
      const created = server.secure ? tlsConnect({ ...options, servername: server.host }, () => resolve(created)) : netConnect(options, () => resolve(created));
      created.setTimeout(timeoutMs, () => { created.destroy(new Error(`连接 ${server.host}:${server.port} 超时`)); });
      created.once('error', error => reject(new Error(`连不上邮件服务器 ${server.host}:${server.port}：${error.message}`)));
    });
    const smtp = new SmtpConnection(socket);
    try {
      await smtp.command(null, [220], '连接邮件服务器');
      let hello = await smtp.command('EHLO travelbot', [250], '握手');
      if (!server.secure) {
        if (!/STARTTLS/i.test(hello.text)) throw new Error('邮件服务器不支持加密连接（STARTTLS），请改用 465 端口并勾选 SSL');
        await smtp.command('STARTTLS', [220], '开启加密');
        await smtp.upgrade(server.host);
        hello = await smtp.command('EHLO travelbot', [250], '握手');
      }
      await smtp.command('AUTH LOGIN', [334], '登录');
      await smtp.command(Buffer.from(server.user, 'utf8').toString('base64'), [334], '登录');
      await smtp.command(Buffer.from(server.password, 'utf8').toString('base64'), [235], '登录（请确认账号和授权码）');
      await smtp.command(`MAIL FROM:<${server.user}>`, [250], '设置发件人');
      for (const to of mail.to) await smtp.command(`RCPT TO:<${to}>`, [250, 251], `添加收件人 ${to}`);
      await smtp.command('DATA', [354], '发送内容');
      const message = [
        `From: ${encodeWord('旅游运营助手')} <${server.user}>`,
        `To: ${mail.to.map(to => `<${to}>`).join(', ')}`,
        `Subject: ${encodeWord(mail.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@travelbot>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(Buffer.from(mail.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')),
      ].join('\r\n');
      await smtp.command(`${message}\r\n.`, [250], '发送内容');
    } finally {
      smtp.close();
    }
  }
}
