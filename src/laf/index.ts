import cloud from "@lafjs/cloud";
import axios from "axios";
import xml2js from "xml2js";
import { decrypt, getSignature } from "@wecom/crypto";
import { Configuration, OpenAIApi } from "openai";

const Config = {
  /** 1: 启用上下文, 0: 关闭上下文 */
  USE_CHAT_CONTEXT: 0,
  /** 预设 prompt */
  DEFAULT_PROMPT: "",
  /** 企业微信应用 corp_id */
  WECOM_CORPID: "",
  /** 企业微信应用 agentId */
  WECOM_AGENT_ID: "",
  /** 企业微信应用 app_secret */
  WECOM_SECRET: "",
  /** 企业微信应用 token */
  WECOM_TOKEN: "",
  /** 企业微信应用 encodingAESKey */
  WECOM_ENCODING_AES_KEY: "",
  /** openAIKey */
  OPEN_AI_KEY: "",
} as const;

/** 企业微信应用 WECOM_BASE_URL */
const WECOM_BASE_URL = "https://qyapi.weixin.qq.com";

class CloudHelper {
  #HISTORY_COLLECTION = "history";

  getCache(key: CacheKey) {
    return cloud.shared.get(key);
  }

  setCache(key: CacheKey, value: any) {
    return cloud.shared.set(key, value);
  }

  get historyCollection() {
    return cloud.database().collection(this.#HISTORY_COLLECTION);
  }

  async getUserMessageHistory(id: string): Promise<string[]> {
    const { data = {} } = await this.historyCollection.doc(id).get();
    return data.message || [];
  }

  async setUserMessageHistory(id: string, message: string[]) {
    return await this.historyCollection.doc(id).set({ message });
  }

  async updateUserMessage({ touser, message }: ParseContent) {
    const historyMessage = await this.getUserMessageHistory(touser);

    const newMessages = [...historyMessage, message];

    await this.setUserMessageHistory(touser, newMessages);

    return { newMessages, historyMessage };
  }
}

const cloudHelper = new CloudHelper();

export async function main(ctx) {
  const logDate = getCurrentDateTime();

  try {
    console.log(
      `======================== ${logDate} start ========================`
    );
    const { body, query } = ctx;

    const { response = "", content } = await parseMessage(body, query);

    if (content) {
      await sendWecom({
        touser: content.touser,
        content: await getReplyContent(content),
      });
    }

    return response;
  } catch (err) {
    console.warn("🚀\n ~ file: Untitled-1:38 ~ main ~ err:", err);
  } finally {
    console.log(
      `========================================================================`
    );
  }
}

function getCurrentDateTime() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const hour = now.getHours();
  const minute = now.getMinutes();

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

interface ParseContent {
  /** 用户名称 */
  touser: any;
  /** 消息内容 */
  message: string;
}

interface ParseReturn {
  response: string;
  content?: ParseContent;
}

async function parseMessage(
  body: { xml },
  query: { msg_signature; timestamp; nonce; echostr }
): Promise<ParseReturn> {
  const res: ParseReturn = { response: "" };

  const { msg_signature, timestamp, nonce, echostr } = query;
  if (echostr) {
    const signature = getSignature(
      Config.WECOM_TOKEN,
      timestamp,
      nonce,
      echostr
    );

    if (signature === msg_signature) {
      res.response = decrypt(Config.WECOM_ENCODING_AES_KEY, echostr).message;
    }
    return res;
  }

  const { xml } = body;
  const { message } = decrypt(Config.WECOM_ENCODING_AES_KEY, xml?.encrypt?.[0]);

  const {
    xml: { FromUserName, Content },
  } = await xml2js.parseStringPromise(message);

  res.content = {
    message: Content[0],
    touser: FromUserName[0],
  };

  return res;
}

const enum CacheKey {
  PROMPT = "prompt",
  ACCESS_TOKEN = "access_token",
}

const enum SystemCommand {
  /** 清空上下文 */
  CLEAN_CONTEXT = "#清空",
}

async function getReplyContent(
  content: ParseContent
): Promise<string | undefined> {
  if (!content) return;

  const { message, touser } = content;

  if (message === SystemCommand.CLEAN_CONTEXT) {
    await cloudHelper.setUserMessageHistory(touser, []);
    return `用户 ${touser} 上下文已清空 ~`;
  } else {
    return await getSmartReply(content);
  }
}

async function getSmartReply(content: ParseContent) {
  const message = content.message;

  if (cloudHelper.getCache(CacheKey.PROMPT) === message) return;

  cloudHelper.setCache(CacheKey.PROMPT, content.message);

  console.warn("🚀\n ~ 问题 ~:", content.message);

  return await getPromptAnswer(content);
}

async function sendWecom({ touser, content }) {
  if (!content) return;

  const access_token = await getWecomAccessToken();

  const { data = {} } = await axios.post(
    `${WECOM_BASE_URL}/cgi-bin/message/send?access_token=${access_token}`,
    {
      touser,
      msgtype: "text",
      agentid: Config.WECOM_AGENT_ID,
      text: { content },
    }
  );

  const { errcode, errmsg } = data;

  // token 过期
  if ([40014, 42201, 42001].includes(errcode)) {
    cloudHelper.setCache(CacheKey.ACCESS_TOKEN, "");
    await sendWecom({ touser, content });
  } else if (errmsg !== "ok") {
    console.warn(
      "🚀\n 企微发送错误 ~ file: index.ts:134 ~ sendWecom ~ errmsg:",
      errmsg
    );
  }
}

async function getWecomAccessToken() {
  const cache = cloudHelper.getCache(CacheKey.ACCESS_TOKEN);
  if (cache) return cache;

  const {
    data: { access_token },
  } = await axios.get(
    `${WECOM_BASE_URL}/cgi-bin/gettoken?corpid=${Config.WECOM_CORPID}&corpsecret=${Config.WECOM_SECRET}`
  );

  cloudHelper.setCache(CacheKey.ACCESS_TOKEN, access_token);

  return access_token;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

async function getChatMessage(
  content: ParseContent
): Promise<Array<ChatMessage>> {
  const { message = "" } = content;

  const userMessage: ChatMessage[] = [{ role: "user", content: message }];

  if (Config.USE_CHAT_CONTEXT) {
    const { historyMessage = [] } = await cloudHelper.updateUserMessage(
      content
    );

    return [
      ...historyMessage.map((content = "") => {
        return {
          role: "system",
          content,
        } as const;
      }),
      ...userMessage,
    ];
  } else {
    return userMessage;
  }
}

async function getPromptAnswer(content: ParseContent): Promise<string> {
  try {
    const configuration = new Configuration({
      apiKey: Config.OPEN_AI_KEY,
    });

    const openai = new OpenAIApi(configuration);

    const messages: ChatMessage[] = [
      { role: "system", content: Config.DEFAULT_PROMPT },
      ...(await getChatMessage(content)),
    ];

    console.warn(
      "🚀\n ~ file: index.ts:277 ~ getPromptAnswer ~ messages:",
      messages
    );

    const response = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages,
      max_tokens: 1024,
    });

    console.warn(
      "🚀\n ~ file: index.ts:288 ~ getPromptAnswer ~ openai.createChatCompletion response",
      response
    );

    console.warn("🚀\n ~ 回复 ~:", response?.data);

    return (
      response?.data?.choices[0]?.message?.content?.trim() ||
      `ヽ(･ω･´ﾒ) 我迷路啦 ~ openai 返回错误 response: ${JSON.stringify(
        response || "undefined"
      )}`
    );
  } catch (err) {
    const { response = {} } = err || {};

    console.warn(
      "🚀\n ~ file: Untitled-1:137 ~ getPromptAnswer ~ response.data:",
      response.data
    );

    console.warn(
      "🚀\n ~ file: Untitled-1:137 ~ getPromptAnswer ~ response.status:",
      response.status,
      response.statusText
    );

    return `(･ェ･。) 我迷路啦 ~ ${err} ~ ${JSON.stringify(response.data)}`;
  }
}
