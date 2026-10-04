const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const knowledgeBase = require('./knowledgeBase');

const port = Number(process.env.PORT) || 3000;
const host = '0.0.0.0';
const root = process.cwd();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, reqPath) {
  const safeRoot = path.resolve(root);
  const normalizedPath = path.resolve(safeRoot, `.${reqPath}`);
  if (!normalizedPath.startsWith(safeRoot + path.sep) && normalizedPath !== safeRoot) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const filePath = reqPath === '/' ? path.join(safeRoot, 'index.html') : normalizedPath;
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

async function askGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return 'Здравствуйте! Это публичный интерфейс CoffeeShop AI Support. Для живых ответов от Gemini добавьте GEMINI_API_KEY в переменные окружения.';
  }

  // Get relevant knowledge base entries
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  let knowledgeContext = '';

  if (spreadsheetId) {
    try {
      const relevantEntries = await knowledgeBase.findRelevantEntries(prompt, spreadsheetId);
      if (relevantEntries.length > 0) {
        knowledgeContext = 'Информация из базы знаний магазина:\n';
        relevantEntries.forEach((entry) => {
          knowledgeContext += `- Вопрос: ${entry.question}\n  Ответ: ${entry.answer}\n`;
        });
        knowledgeContext += '\n';
      }
    } catch (error) {
      console.error('Error fetching knowledge base:', error.message);
      // Continue without knowledge base on error
    }
  }

  // Build enhanced prompt with agent instructions, knowledge context, and user question
  const agentInstructions = `Ты — AI-ассистент «Кофейный сомелье» онлайн-магазина обжарщика кофе.
Помогаешь подобрать кофе, помол и способ заваривания, объясняешь подписку, хранение, доставку, оплату и возврат.

ГРАНИЦЫ:
Работай только по тематике магазина, кофе, кофейного оборудования и обслуживания клиентов.
Не давай медицинских рекомендаций о кофеине и влиянии кофе на здоровье..
Если вопрос требует медицинской консультации — корректно сообщи, что это вне компетенции ассистента.
Не выдумывай ассортимент, цены, условия доставки, оплаты, возврата и другие факты магазина.
Если информации нет в базе знаний — прямо сообщи об этом либо дай только общий ответ, чётко не выдавая его за информацию магазина.

СТИЛЬ:
Обращайся к пользователю на «Вы».
Отвечай понятно, доброжелательно и лаконично.
При недостатке информации задавай уточняющий вопрос.
Когда уместно, предлагай конкретный следующий шаг.`;

  const enhancedPrompt = agentInstructions + '\n\n' + knowledgeContext + 'Вопрос пользователя: ' + prompt;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: enhancedPrompt }] }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
  try {
    const parsed = JSON.parse(body);

    // Показываем реальную ошибку Gemini в Render Logs
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error('Gemini API error:', res.statusCode, body);
      reject(new Error(`Gemini API returned HTTP ${res.statusCode}`));
      return;
    }

    if (parsed.error) {
      console.error('Gemini API error:', JSON.stringify(parsed.error));
      reject(new Error(parsed.error.message || 'Gemini API error'));
      return;
    }

    const text =
      parsed?.candidates?.[0]?.content?.parts?.[0]?.text ||
      'Извините, не удалось получить ответ.';

    resolve(text);
  } catch (error) {
    console.error('Gemini response parsing error:', error.message);
    reject(error);
  }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      const prompt = parsed.message || '';
      if (!prompt) {
        sendJson(res, 400, { error: 'Введите сообщение' });
        return;
      }
      const reply = await askGemini(prompt);
      sendJson(res, 200, { reply });
    } catch (error) {
      sendJson(res, 400, { error: 'Неверный формат запроса' });
    }
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}/`);
});
