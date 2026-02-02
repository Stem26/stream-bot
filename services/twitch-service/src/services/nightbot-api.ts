export class NightbotAPI {
  private token: string;
  private lastRequestTime: number = 0;
  private readonly RATE_LIMIT_MS = 5000;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Отправка сообщения в чат через Nightbot
   * @param message - текст сообщения (макс. 400 символов)
   * @param chatId - опционально, ID конкретного чата (для YouTube с несколькими чатами)
   */
  async sendMessage(message: string, chatId?: string): Promise<boolean> {
    try {
      if (message.length > 400) {
        console.warn('⚠️ Сообщение слишком длинное, обрезаем до 400 символов');
        message = message.substring(0, 397) + '...';
      }

      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      
      if (timeSinceLastRequest < this.RATE_LIMIT_MS) {
        const waitTime = this.RATE_LIMIT_MS - timeSinceLastRequest;
        console.log(`⏳ Ожидание ${Math.ceil(waitTime / 1000)}с перед отправкой (rate limit)...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      console.log(`📤 Отправка через Nightbot API: ${message}`);

      const data: any = { message };
      if (chatId) {
        data.chatId = chatId;
      }

      const response = await fetch('https://api.nightbot.tv/1/channel/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
      });

      this.lastRequestTime = Date.now();

      if (response.ok) {
        const result = await response.json();
        console.log('✅ Сообщение отправлено через Nightbot API:', result);
        return true;
      } else {
        const errorText = await response.text();
        console.error('❌ Неожиданный статус ответа:', response.status, errorText);
        return false;
      }
    } catch (error: any) {
      console.error('❌ Ошибка при отправке через Nightbot API:');
      
      if (error.response) {
        console.error('   Статус:', error.response.status);
        console.error('   Данные:', error.response.data);
        
        if (error.response.status === 429) {
          console.error('   🚫 Rate limit превышен! Слишком много запросов.');
        } else if (error.response.status === 401) {
          console.error('   🔑 Ошибка авторизации! Проверьте NIGHTBOT_TOKEN в .env');
        }
      } else {
        console.error('   Ошибка:', error.message);
      }
      
      return false;
    }
  }
}
