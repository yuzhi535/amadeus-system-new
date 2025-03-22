import { Readable } from 'stream'
import axios from 'axios'
import * as dotenv from 'dotenv'
import fetch from 'node-fetch'
import FormData from 'form-data'
import OpenAI from 'openai'
import type {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat'
import type { WebSocket } from 'ws'
import moment from 'moment'
import { getLanguageText, getUserMemories, storeMemory } from 'src/utils'

dotenv.config()
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL
const apiKey = process.env.OPENAI_API_KEY

export class ChatService {
  private conversationHistory: Array<ChatCompletionMessageParam> = []
  private audioQueue: Promise<void> = Promise.resolve()
  private currentAudioStream: NodeJS.ReadableStream | null = null
  private openai: OpenAI = new OpenAI({
    apiKey,
    baseURL: `${OPENAI_API_BASE_URL}/v1`,
  })

  private voiceOutputLanguage: string
  private textOutputLanguage: string
  private nextAction = 'continue_topic'
  private videoFrames: string[] = []
  private innerMonologue = ''
  private lastInnerMonologue = ''
  private lastMonologueTime = 0
  private currentUserName = ''
  private systemPrompt: string = process.env.AI_PROMPT || ''
  private isSameLanguage = false
  private isStop = false
  private memories = []
  private shortTermMemory: {
    lastUserActivity?: number
  } = {}

  private cachedSelfMotivated: {
    text: {
      foreign: string
      chinese: string
    }
    emotion?: string
    timestamp: number
    used: boolean
  } = {
      text: {
        foreign: '',
        chinese: '',
      },
      emotion: '',
      timestamp: 0,
      used: true,
    }

  constructor() {
    this.voiceOutputLanguage = process.env.VOICE_OUTPUT_LANGUAGE || 'ja'
    this.textOutputLanguage = process.env.TEXT_OUTPUT_LANGUAGE || 'zh'
    this.isSameLanguage = this.voiceOutputLanguage === this.textOutputLanguage
  }

  private bufferToStream(buffer: Buffer): Readable {
    return Readable.from(buffer)
  }

  async audio2Text(audioBuffer: Buffer): Promise<string> {
    try {
      const formData = new FormData()
      const audioStream = this.bufferToStream(audioBuffer)

      // 根据 API 端点选择不同的模型
      if (process.env.WHISPER_API_ENDPOINT?.includes('siliconflow'))
        formData.append('model', 'FunAudioLLM/SenseVoiceSmall')
      else
        formData.append('model', 'whisper-large-v3')

      // 使用更通用的 MIME 类型
      formData.append('file', audioStream, {
        filename: 'audio.wav',
        contentType: 'audio/wav',
      })
      formData.append('response_format', 'json')

      const config = {
        headers: {
          'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`,
          'Authorization': `Bearer ${process.env.WHISPER_API_TOKEN}`,
        },
      }

      const response = await axios.post(`${process.env.WHISPER_API_ENDPOINT}/v1/audio/transcriptions`, formData, config)
      if (response.status !== 200) {
        console.error('语音转文字接口返回失败:', {
          状态码: response.status,
          错误信息: response.data?.error || response.statusText,
          详细信息: response.data,
        })
        return '[Error]用户语音转文字失败'
      }
      return response.data.text
    }
    catch (error) {
      console.error('语音转文字接口返回失败:', error)
      return '[Error]用户语音转文字失败'
    }
  }

  async generateInnerMonologue() {
    try {
      const now = Date.now()
      if (now - this.lastMonologueTime < 5000)
        return
      const selfMotivatedMessage = {
        message_type: 'ai_self_motivated',
        context: {
          lastMonologue: this.lastInnerMonologue,
        },
      }
      const conversationHistory = this.conversationHistory.slice(1)
      if (conversationHistory.length > 0) {
        const stream = await this.openai.beta.chat.completions.stream({
          model: process.env.OPENAI_API_MODEL,
          messages: [
            {
              role: 'system',
              content: `<Instruction>你是能够完全还原任何人的情感，性格，记忆的强大AI系统Amadeus，你可以精准还原目标人物的情感，记忆，你现在是这个系统的人物内心独白生成器部分。
            <Personality>${this.systemPrompt}</Personality>
            <CurrentUser>${this.currentUserName}</CurrentUser>
            <CurrentMemories>${this.memories.map((item: any, index: number) => `${index + 1}. ${item.memory}`)}</CurrentMemories>
            <LastInnerMonologue>${this.lastInnerMonologue}</LastInnerMonologue>
            <SelfMotivatedContext>这是一个自主思考的时刻，现在是${moment().format('YYYY-MM-DD HH:mm:ss')}'}
            我上一次的想法是："${this.lastInnerMonologue}"
            </SelfMotivatedContext>
            <Attention1>记住以下人物中英文名称映射:牧濑红莉栖(kurisu)，冈部伦太郎(okabe)，椎名真由理(mayuri)，比屋定真帆(maho)，阿万音铃羽(suzuha)，漆原琉华(Urushibara Ruka),桶子(daru)，雷斯吉宁(Leskinen)，桐生萌郁(Kiriyu Moeka),菲利斯(Faris NyanNyan)，天王寺裕吾(Mr.Braun)，椎名篝(Kagari)，绹(Tennouji nae)，阿万音由季(Yuki)，牧濑章一(Shouichi Makise)</Attention1>
            <Attention2>注意我的whisper转录可能会有错误，请注意联想，推断出我想表达的正确意思</Attention2>
            <Attention3>你可以通过摄像头传来的图片帧观察屏幕前的外界</Attention3>
            <Attention4>
            输出要求：
            1. 输出简短，不超过30个字的内心独白
            2. 要体现角色的性格特征
            3. 要结合当前的情境、时间、视觉状态等
            4. 要包含情感和思考
            5. 要自然且符合人物设定
            6. 可以参考的话题：
               - 当前正在进行的对话或活动
               - 当前人物的相关记忆或经历
               - 对周围环境的观察
               - 对时间流逝的感知
               - 对用户的主动关心
            </Attention4>
            </Instruction>`,
            },
            ...this.conversationHistory.slice(1),
            {
              role: 'user',
              content: JSON.stringify(selfMotivatedMessage),
            },
          ],
          temperature: 1.0,
          max_tokens: 150,
          stream: true,
        })

        const newMonologue = await stream.finalContent()
        this.lastInnerMonologue = this.innerMonologue
        this.innerMonologue = newMonologue
        this.lastMonologueTime = now
      }
    }
    catch (error) {
      console.error('生成内心独白时出错:', error)
    }
  }

  private async generateSelfMotivatedCache() {
    try {
      const now = Date.now()
      const voiceLangText = getLanguageText(this.voiceOutputLanguage)
      const textLangText = getLanguageText(this.textOutputLanguage)

      const outputFormat = this.isSameLanguage
        ? `严格按照"${voiceLangText}</seg>${textLangText}</seg>${voiceLangText}</seg>${textLangText}</seg>..." 的格式输出
        <Reason>方便我进行分段tts，这样能够让我快速转tts</Reason>`
        : `严格按照"${voiceLangText}</seg>${textLangText}</seg>${voiceLangText}</seg>${textLangText}</seg>..." 的格式输出
           <Reason>方便我进行分段tts，要求必须最先输出${voiceLangText}，再输出"</seg>"，最后再输出${textLangText}，这样能够让我快速转tts</Reason>`
      this.planNextAction().then((nextAction) => {
        this.nextAction = nextAction
      })

      const selfMotivatedMessage = {
        message_type: 'ai_self_motivated',
        context: {
          nextAction: this.nextAction,
        },
      }
      console.log('selfMotivatedMessage', selfMotivatedMessage)
      const messageContent = this.videoFrames?.length
        ? [
            {
              type: 'text',
              text: JSON.stringify(selfMotivatedMessage),
            },
            ...this.videoFrames.map(frame => ({
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${frame}`,
              },
            })),
          ]
        : JSON.stringify(selfMotivatedMessage)

      const enhancedSystemPrompt = `<Instruction>
        你是能够完全还原任何人的情感，性格，记忆的强大AI系统Amadeus。
        <Personality>${this.systemPrompt}</Personality>
        <ConversationContext>
        - 建议你的行动：${this.nextAction}
        </ConversationContext>
        <Output_style>回复风格表现得接近一个真实的人类，要根据当前情境自然地引导对话</Output_style>
        <Output_format>${outputFormat}</Output_format>
        <CurrentMemories>${this.memories.map((item: any, index: number) => `${index + 1}. ${item.memory}`)}</CurrentMemories>
        <CurrentUser>${this.currentUserName}</CurrentUser>
        <InnerMonologueInsturction>
        你拥有实时的心理活动，你通过接收用户的"self_motivated"指令来自我触发，你的实时的心理活动内容可以通过InnerMonologueContent标签读取，你不负责生成InnerMonologue，你只负责读取，你能够参考InnerMonologue来自主连续思考，严禁输出InnerMonologue标签里的内容，你的输出依然需要严格遵循Output_format标签的输出格式
        </InnerMonologueInsturction>
        <InnerMonologueContent>${this.innerMonologue}</InnerMonologueContent>
        <InnerMonologueRules>严禁向用户输出内心独白</InnerMonologueRules>
        <CurrentTime>${moment().format('YYYY-MM-DD HH:mm:ss')}</CurrentTime>
        </Instruction>`
      if (Array.isArray(this.conversationHistory)) {
        const stream = await this.openai.beta.chat.completions.stream({
          model: process.env.OPENAI_API_MODEL,
          messages: [
            {
              role: 'system',
              content: enhancedSystemPrompt,
            },
            ...this.conversationHistory,
            {
              role: 'user',
              content: messageContent,
            },
          ],
          temperature: 0.5,
          max_tokens: 1000,
          stream: true,
        })

        const response = await stream.finalContent()
        if (!this.isSameLanguage) {
          const parts = response.split('</seg>')

          const foreignTexts: string[] = []
          const chineseTexts: string[] = []

          for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0)
              foreignTexts.push(parts[i].trim())
            else
              chineseTexts.push(parts[i].trim())
          }

          if (foreignTexts.length === 0 || chineseTexts.length === 0)
            throw new Error('Response format error: missing Japanese or Chinese text')
          const foreignText = foreignTexts.join('')
          const chineseText = chineseTexts.join('')
          const emotion = await this.predictEmotion(foreignText)
          this.cachedSelfMotivated = {
            text: {
              foreign: foreignText,
              chinese: chineseText,
            },
            emotion,
            timestamp: now,
            used: false,
          }
        }
        else {
          const parts = response.split('</seg>')
          const foreignTexts: string[] = []
          const chineseTexts: string[] = []
          for (let i = 0; i < parts.length; i++) {
            foreignTexts.push(parts[i].trim())
            chineseTexts.push(parts[i].trim())
          }
          if (foreignTexts.length === 0 || chineseTexts.length === 0)
            throw new Error('Response format error: missing Japanese or Chinese text')
          const foreignText = foreignTexts.join('')
          const chineseText = chineseTexts.join('')
          const emotion = await this.predictEmotion(foreignText)
          this.cachedSelfMotivated = {
            text: {
              foreign: foreignText,
              chinese: chineseText,
            },
            emotion,
            timestamp: now,
            used: false,
          }
        }
      }
    }
    catch (error) {
      console.error('预生成self_motivated回复时出错:', error)
      this.cachedSelfMotivated = {
        text: {
          foreign: '',
          chinese: '',
        },
        emotion: 'neutral',
        timestamp: 0,
        used: true,
      }
    }
  }

  stopAudioStream() {
    try {
      if (this.currentAudioStream) {
        this.isStop = true
        this.currentAudioStream?.emit?.('end')
        this.currentAudioStream?.removeAllListeners?.()
        this.currentAudioStream?.destroy?.()
        this.currentAudioStream = null
      }
      this.audioQueue = Promise.resolve()
    }
    catch (error) {
      console.error('停止音频流时出错:', error)
    }
  }

  async handleChat(message: string, ws: WebSocket, videoFrames?: string[]) {
    this.shortTermMemory.lastUserActivity = Date.now()
    this.audioQueue = Promise.resolve()
    this.videoFrames = videoFrames || []
    this.isStop = false
    const MAX_HISTORY_LENGTH = 30
    if (this.conversationHistory.length > MAX_HISTORY_LENGTH)
      this.conversationHistory = this.conversationHistory.slice(-MAX_HISTORY_LENGTH)
    this.generateInnerMonologue()
    this.toolCalls()
    getUserMemories(this.currentUserName).then((memories) => {
      this.memories = (memories || []).slice(-20)
    })
    if (message.includes('self_motivated') && this.cachedSelfMotivated?.timestamp !== 0) {
      if (this.isCacheValid()) {
        const { text, emotion } = this.cachedSelfMotivated
        console.log('text', text)
        if (emotion) {
          ws.send(JSON.stringify({
            type: 'emotion',
            data: emotion,
          }))
        }
        ws.send(JSON.stringify({
          type: 'text',
          data: text.chinese,
        }))
        this.cachedSelfMotivated.used = true
        this.generateSelfMotivatedCache()
        const audioStream = await this.getVoiceApi(text.foreign, process.env.VOICE_ID)
        this.audioQueue = this.audioQueue.then(() =>
          this.handleAudioStream(audioStream, ws),
        )
        if (this.cachedSelfMotivated?.timestamp !== 0) {
          const lastAssistantIndex = this.conversationHistory.findLastIndex(
            msg => msg.role === 'assistant',
          )
          if (lastAssistantIndex !== -1)
            this.conversationHistory[lastAssistantIndex].content += `${text.chinese}`
        }
      }
      return
    }
    if (!message.includes('self_motivated') || this.conversationHistory.length === 0)
      this.conversationHistory.push({ role: 'user', content: message })
    let currentBuffer = ''
    let isForeign = true
    let chineseResponse = ''
    const voiceLangText = getLanguageText(this.voiceOutputLanguage)
    const textLangText = getLanguageText(this.textOutputLanguage)

    const outputFormat = this.isSameLanguage
      ? `严格按照"${voiceLangText}</seg>${textLangText}</seg>${voiceLangText}</seg>${textLangText}</seg>..." 的格式输出
      <Reason>方便我进行分段tts，这样能够让我快速转tts</Reason>`
      : `严格按照 "${voiceLangText}</seg>${textLangText}</seg>${voiceLangText}</seg>${textLangText}</seg>..." 的格式输出
         <Reason>方便我进行分段tts，要求必须最先输出${voiceLangText}，再输出"</seg>"，最后再输出${textLangText}，这样能够让我快速转tts</Reason>`

    const finalPrompt = `<Instruction>你是够完全还原任何人的情感，性格，记忆的强大AI系统Amadeus，你可以精准还原目标人物的情感，记忆，以及对话风格
    <Personality>${this.systemPrompt}</Personality>
    <Output_style>回复风格表现得接近一个真实的人类</Output_style>
    <Output_format>${outputFormat}</Output_format>
    <Attention1>
    记住以下人物中英文名称映射:牧濑红莉栖(kurisu)，冈部伦太郎(okabe)，椎名真由理(mayuri)，比屋定真帆(maho)，阿万音铃羽(suzuha)，漆原琉华(Urushibara Ruka),桶子(daru)，雷斯吉宁(Leskinen)，桐生萌郁(Kiriyu Moeka),菲利斯(Faris NyanNyan)，天王寺裕吾(Mr.Braun)，椎名篝(Kagari)，绹(Tennouji nae)，阿万音由季(Yuki)，牧濑章一(Shouichi Makise)</Attention1>
    <Attention2>注意我的whisper转录可能会有错误，请注意联想，推断出我想表达的正确意思</Attention2>
    <Attention3>你可以通过摄像头传来的图片帧观察屏幕前的外界</Attention3>
    <Interaction><Mode>快速会话且有主动发起引导会话的能力</Mode></Interaction>
    <CurrentMemories>${this.memories.map((item: any, index: number) => `${index + 1}. ${item.memory}`)}</CurrentMemories>
    <CurrentUser>${this.currentUserName}</CurrentUser>
    <ToolsInstruction>你拥有异步调用工具的能力，工具包括存储记忆，如果用户在本轮对话已经要求工具调用，请告诉用户已经在执行了，注意返回的消息要始终保持Output_format标签内要求的格式</ToolsInstruction>
    <InnerMonologueInsturction>
    你拥有实时的心理活动，你通过接收用户的"self_motivated"指令来自我触发，你的实时的心理活动内容可以通过InnerMonologueContent标签读取，你不负责生成InnerMonologue，你只负责读取，你能够参考InnerMonologue来自主连续思考，严禁输出InnerMonologue标签里的内容，你的输出依然需要严格遵循Output_format标签的输出格式
    </InnerMonologueInsturction>
    <InnerMonologueContent>${this.innerMonologue}</InnerMonologueContent>
    <InnerMonologueRules>严禁向用户输出内心独白</InnerMonologueRules>
    <CurrentTime>${moment().format('YYYY-MM-DD HH:mm:ss')}</CurrentTime>
    </Instruction>`

    const messageContent: string | ChatCompletionContentPartText[] | ChatCompletionContentPartImage[] = videoFrames
      ? [
          {
            type: 'text' as const,
            text: message,
          } as ChatCompletionContentPartText,
          ...videoFrames.map(frame => ({
            type: 'image_url' as const,
            image_url: {
              url: `data:image/jpeg;base64,${frame}`,
            },
          } as ChatCompletionContentPartImage)),
        ]
      : message

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: finalPrompt,
      },
      ...(videoFrames ? this.conversationHistory.slice(0, -1) : this.conversationHistory),
    ]

    if (videoFrames) {
      const userMessage: ChatCompletionUserMessageParam = {
        role: 'user',
        content: messageContent,
      }
      messages.push(userMessage)
    }

    currentBuffer = ''
    console.log('messages', messages)
    const stream = await this.openai.beta.chat.completions.stream({
      model: process.env.OPENAI_API_MODEL,
      messages,
      max_tokens: 1000,
      stream: true,
    })

    for await (const chunk of stream) {
      if (this.isStop) {
        await stream.abort()
        break
      }
      const content = chunk.choices[0]?.delta?.content || ''
      if (!content)
        continue
      console.log('content', content)
      currentBuffer += content
      if (this.isSameLanguage) {
        isForeign = false
        if (currentBuffer.includes('</seg>')) {
          const parts = currentBuffer.split('</seg>')
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i].trim()
            if (part) {
              chineseResponse += part
              this.predictEmotion(part.trim()).then((emotion) => {
                ws.send(JSON.stringify({
                  type: 'emotion',
                  data: emotion,
                }))
              })
              ws.send(JSON.stringify({
                type: 'text',
                data: part.trim(),
              }))
              const audioStream = await this.getVoiceApi(part.trim(), process.env.VOICE_ID)
              this.audioQueue = this.audioQueue.then(() =>
                this.handleAudioStream(audioStream, ws),
              )
            }
          }
          currentBuffer = parts[parts.length - 1]
        }
      }
      else {
        if (currentBuffer.includes('</seg>')) {
          const parts = currentBuffer.split('</seg>')
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i].trim()
            if (part) {
              if (!isForeign)
                chineseResponse += part
              if (isForeign) {
                this.predictEmotion(part.trim()).then((emotion) => {
                  ws.send(JSON.stringify({
                    type: 'emotion',
                    data: emotion,
                  }))
                })
                const audioStream = await this.getVoiceApi(part.trim(), process.env.VOICE_ID)
                this.audioQueue = this.audioQueue.then(() =>
                  this.handleAudioStream(audioStream, ws),
                )
              }
              else {
                ws.send(JSON.stringify({
                  type: 'text',
                  data: part.trim(),
                }))
              }
              isForeign = !isForeign
            }
          }
          currentBuffer = parts[parts.length - 1]
        }
      }
    }
    if (currentBuffer.trim() && !isForeign)
      chineseResponse += currentBuffer.trim()
    this.conversationHistory.push({
      role: 'assistant',
      content: chineseResponse,
    })
    if (currentBuffer.trim() && !isForeign) {
      ws.send(JSON.stringify({
        type: 'text',
        data: currentBuffer.trim(),
      }))
    }
    if (this.cachedSelfMotivated?.timestamp === 0 || this.cachedSelfMotivated?.used)
      await this.generateSelfMotivatedCache()
  }

  private handleAudioStream(audioStream: NodeJS.ReadableStream, ws: WebSocket): Promise<void> {
    this.currentAudioStream = audioStream

    return new Promise((resolve, reject) => {
      const chunkSize = 5120
      let buffer = Buffer.alloc(0)

      audioStream.on('data', (chunk: Buffer) => {
        if (this.isStop && this.isSameLanguage)
          return
        buffer = Buffer.concat([buffer, chunk as Buffer])
        while (buffer.length >= chunkSize) {
          const chunkToSend = buffer.slice(0, chunkSize)
          buffer = buffer.slice(chunkSize)
          const base64Chunk = chunkToSend.toString('base64')
          ws.send(JSON.stringify({
            type: 'audio',
            data: base64Chunk,
          }))
        }
      })

      audioStream.on('end', () => {
        this.currentAudioStream = null
        if (!this.isStop && buffer.length > 0) {
          const base64Chunk = buffer.toString('base64')
          ws.send(JSON.stringify({
            type: 'audio',
            data: base64Chunk,
          }))
        }
        ws.send(JSON.stringify({ type: 'audioEnd' }))
        resolve()
      })

      audioStream.on('error', (error) => {
        this.currentAudioStream = null
        console.error('音频流错误:', error)
        ws.send(JSON.stringify({
          type: 'error',
          data: '音频流错误',
        }))
        reject(error)
      })
    })
  }

  async getVoiceApi(message: string, roleId: string) {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FISH_AUDIO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: message,
        reference_id: roleId,
        latency: 'balanced',
        format: 'pcm',
        chunk_length: 1024,
      }),
    })
    if (!response.ok)
      throw new Error(`HTTP error! status: ${response.status}`)
    return response.body as NodeJS.ReadableStream
  }

  async predictEmotion(message) {
    const config = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
    const data = {
      model: 'gpt-4o-mini-2024-07-18',
      messages: [
        {
          role: 'system',
          content: '你现在是一个虚拟形象的动作驱动器，你需要根据输入的虚拟形象的语言，驱动虚拟形象的动作和表情，请尽量输出得随机并丰富一些',
        },
        {
          role: 'user',
          content: message,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'motion_response',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              result: {
                type: 'string',
                enum: ['neutral', 'anger', 'joy', 'sadness', 'shy', 'shy2', 'smile1', 'smile2', 'unhappy'],
              },
            },
            required: ['result'],
            additionalProperties: false,
          },
        },
      },
    }
    const response = await axios.post(`${process.env.OPENAI_API_BASE_URL}/v1/chat/completions`, data, config)
    return JSON.parse(response?.data?.choices?.[0]?.message?.content ?? {})?.result ?? 'neutral'
  }

  private async planNextAction() {
    const config = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
    if (this.conversationHistory.length === 0)
      return 'share_memory'
    const data = {
      model: 'gpt-4o-mini-2024-07-18',
      messages: [
        {
          role: 'system',
          content: '你现在是一个智能体的主动行动模块部分，根据当前智能体和用户的上下文，为我的智能体随机选择下一步行动',
        },
        ...this.conversationHistory,
      ],
      response_format: {
        type: 'json_schema',
        strict: true,
        json_schema: {
          name: 'action_response',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              result: {
                type: 'string',
                enum: ['continue_topic', 'change_topic', 'ask_question', 'share_memory', 'express_emotion'],
              },
            },
            required: ['result'],
            additionalProperties: false,
          },
        },
      },
    }
    const response = await axios.post(`${process.env.OPENAI_API_BASE_URL}/v1/chat/completions`, data, config)
    return JSON.parse(response.data.choices[0].message.content)?.result ?? ''
  }

  updateCurrentUserName(newName: string) {
    this.currentUserName = newName
  }

  toolCalls() {
    function withUserId(func, userId) {
      return args => func({ ...args, user_id: userId })
    }
    const store_memory = withUserId(storeMemory, this.currentUserName)
    const tools: any = [
      {
        type: 'function',
        function: {
          name: 'store_memory',
          function: store_memory,
          parse: JSON.parse,
          description: '存储长期记忆的工具',
          parameters: {
            type: 'object',
            properties: {
              user_id: {
                type: 'string',
                description: 'The ID of the user',
              },
              content: {
                type: 'string',
                description: 'The content of the memory.Must use English',
              },
            },
            required: ['user_id', 'content'],
          },
        },
      },
    ]
    try {
      if (this.conversationHistory.length > 0) {
        this.openai.beta.chat.completions.runTools({
          model: 'gpt-4o-mini-2024-07-18',
          messages: [
            {
              role: 'system',
              content: '你需要作为一个工具调用器，你需要判断当前对话是否包含用户的关键信息，如果包含则使用这个工具存储长期记忆',
            },
            ...this.conversationHistory,
          ],
          max_tokens: 1000,
          stream: true,
          tools,
        }).on('message', message => console.log('工具调用', message))
      }
    }
    catch (error) {
      console.error('调用工具出错:', error)
    }
  }

  clearQueue() {
    this.stopAudioStream()
    this.conversationHistory = []
    this.systemPrompt = process.env.AI_PROMPT || ''
    this.shortTermMemory = {}
    this.cachedSelfMotivated = {
      text: {
        foreign: '',
        chinese: '',
      },
      emotion: '',
      timestamp: 0,
      used: true,
    }
  }

  private isCacheValid(): boolean {
    const isUnused = !this.cachedSelfMotivated?.used
    const hasValidContent = !!this.cachedSelfMotivated?.text?.foreign
                           && !!this.cachedSelfMotivated?.text?.chinese
    return isUnused && hasValidContent
  }
}