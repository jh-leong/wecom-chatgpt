import cloud from "@lafjs/cloud";
import axios from "axios";
import xml2js from "xml2js";
import { decrypt, getSignature } from "@wecom/crypto";
import { Configuration, OpenAIApi } from "openai";

const enum Config {
  /** 预设 prompt */
  DEFAULT_PROMPT = "",
  /** 企业微信应用 corp_id */
  WECOM_CORPID = "",
  /** 企业微信应用 agentId */
  WECOM_AGENT_ID = "",
  /** 企业微信应用 app_secret */
  WECOM_SECRET = "",
  /** 企业微信应用 token */
  WECOM_TOKEN = "",
  /** 企业微信应用 encodingAESKey */
  WECOM_ENCODING_AES_KEY = "",
  /** openAIKey */
  OPEN_AI_KEY = "",
}

/** 企业微信应用 WECOM_BASE_URL */
const WECOM_BASE_URL = "https://qyapi.weixin.qq.com";

export async function main(ctx) {
  const logDate = getCurrentDateTime();

  try {
    console.log(
      `======================== ${logDate} start ========================`
    );
    const { body, query } = ctx;

    const { response = "", content } = await parseMessage(body, query);

    content && (await smartReply(content));

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

interface ParseReturn {
  response: string;
  content?: { touser: any; message: string };
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
  PROMPT = "promtp",
  ACCESS_TOKEN = "access_token",
}

async function smartReply(content: { touser: any; message: string }) {
  const message = content.message;

  if (getCache(CacheKey.PROMPT) === message) return;

  setCache(CacheKey.PROMPT, content.message);

  console.warn("🚀\n ~ 问题 ~:", content.message);

  const answer = await getPromptAnswer(content.message);

  await sendWecom({ ...content, content: answer });
}

async function sendWecom({ touser, content }) {
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

  if (errmsg) {
    console.warn(
      "🚀\n 企微发送错误 ~ file: index.ts:134 ~ sendWecom ~ errmsg:",
      errmsg
    );
  }

  if ([40014, 42201, 42001].includes(errcode)) {
    setCache(CacheKey.ACCESS_TOKEN, "");
    await sendWecom({ touser, content });
  }
}

async function getWecomAccessToken() {
  const cache = getCache(CacheKey.ACCESS_TOKEN);
  if (cache) return cache;

  const {
    data: { access_token },
  } = await axios.get(
    `${WECOM_BASE_URL}/cgi-bin/gettoken?corpid=${Config.WECOM_CORPID}&corpsecret=${Config.WECOM_SECRET}`
  );

  setCache(CacheKey.ACCESS_TOKEN, access_token);

  return access_token;
}

function getCache(key: CacheKey) {
  return cloud.shared.get(key);
}

function setCache(key: CacheKey, value: any) {
  return cloud.shared.set(key, value);
}

async function getPromptAnswer(prompt: string): Promise<string> {
  try {
    const configuration = new Configuration({
      apiKey: Config.OPEN_AI_KEY,
    });

    const openai = new OpenAIApi(configuration);

    const { data } = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: Config.DEFAULT_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 1024,
    });

    console.warn("🚀\n ~ 回复 ~:", data);

    return data?.choices[0]?.message?.content?.trim() || "ヽ(･ω･´ﾒ) 我迷路啦 ~";
  } catch (err) {
    const { response } = err;

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
