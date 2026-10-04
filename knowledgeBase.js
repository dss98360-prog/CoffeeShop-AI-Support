const https = require('https');
const { URL } = require('url');

let cachedData = null;
let cacheTimestamp = null;

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 5;

/**
 * Корректный разбор CSV.
 * Поддерживает запятые, кавычки и переносы строк внутри полей.
 */
function parseCSV(csvData) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let insideQuotes = false;
  let i = 0;

  while (i < csvData.length) {
    const char = csvData[i];
    const nextChar = csvData[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i += 2;
        continue;
      }

      insideQuotes = !insideQuotes;
      i++;
      continue;
    }

    if (char === ',' && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r' && nextChar === '\n') {
      if (insideQuotes) {
        currentField += '\n';
      } else {
        currentRow.push(currentField.trim());

        if (currentRow.some((field) => field.length > 0)) {
          rows.push(currentRow);
        }

        currentRow = [];
        currentField = '';
      }

      i += 2;
      continue;
    }

    if (char === '\n') {
      if (insideQuotes) {
        currentField += '\n';
      } else {
        currentRow.push(currentField.trim());

        if (currentRow.some((field) => field.length > 0)) {
          rows.push(currentRow);
        }

        currentRow = [];
        currentField = '';
      }

      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if (insideQuotes) {
    throw new Error('Knowledge base CSV contains an unclosed quoted field');
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());

    if (currentRow.some((field) => field.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Проверяет структуру CSV и преобразует строки в объекты базы знаний.
 */
function validateAndParseKnowledge(csvData) {
  const rows = parseCSV(csvData);

  if (rows.length < 2) {
    throw new Error('Knowledge base CSV is empty or has no data rows');
  }

  const headers = rows[0].map((header) =>
    header.replace(/^\uFEFF/, '').trim().toLowerCase()
  );

  const categoryIndex = headers.indexOf('category');
  const questionIndex = headers.indexOf('question');
  const answerIndex = headers.indexOf('answer');
  const tagsIndex = headers.indexOf('tags');

  if (
    categoryIndex === -1 ||
    questionIndex === -1 ||
    answerIndex === -1 ||
    tagsIndex === -1
  ) {
    throw new Error(
      'Knowledge base CSV has invalid structure. Expected columns: category, question, answer, tags'
    );
  }

  const requiredMaxIndex = Math.max(
    categoryIndex,
    questionIndex,
    answerIndex,
    tagsIndex
  );

  const entries = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (row.every((field) => field.length === 0)) {
      continue;
    }

    if (row.length <= requiredMaxIndex) {
      console.warn(
        `Knowledge base: skipping row ${i + 1} (insufficient columns)`
      );
      continue;
    }

    entries.push({
      category: row[categoryIndex] || '',
      question: row[questionIndex] || '',
      answer: row[answerIndex] || '',
      tags: row[tagsIndex] || ''
    });
  }

  if (entries.length === 0) {
    throw new Error('Knowledge base CSV contains no valid data rows');
  }

  return entries;
}

/**
 * Загружает URL с поддержкой HTTP redirects.
 */
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          res.resume();

          if (!location) {
            reject(
              new Error(
                `HTTP ${res.statusCode} received but Location header is missing`
              )
            );
            return;
          }

          if (redirectCount >= MAX_REDIRECTS) {
            reject(
              new Error('Too many redirects while fetching Google Sheets')
            );
            return;
          }

          let nextUrl;

          try {
            nextUrl = new URL(location, url).toString();
          } catch (error) {
            reject(new Error(`Invalid redirect URL: ${location}`));
            return;
          }

          fetchUrl(nextUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);

          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();

          reject(
            new Error(
              `HTTP ${res.statusCode} from Google Sheets. Only 2xx responses accepted.`
            )
          );

          return;
        }

        res.setEncoding('utf8');

        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const entries = validateAndParseKnowledge(data);
            resolve(entries);
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Формирует URL публичного CSV листа "База знаний".
 */
function fetchKnowledgeBase(spreadsheetId) {
  if (!spreadsheetId) {
    return Promise.reject(
      new Error('GOOGLE_SHEETS_SPREADSHEET_ID not configured')
    );
  }

  const sheetName = 'База знаний';
  const encodedSheetName = encodeURIComponent(sheetName);

  const csvUrl =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}` +
    `/gviz/tq?tqx=out:csv&sheet=${encodedSheetName}`;

  return fetchUrl(csvUrl);
}

/**
 * Возвращает базу знаний.
 * Кэш действует 5 минут.
 * При ошибке используется последняя успешно загруженная копия.
 */
async function getKnowledgeBase(spreadsheetId) {
  const now = Date.now();

  if (
    cachedData &&
    cacheTimestamp &&
    now - cacheTimestamp < CACHE_TTL_MS
  ) {
    return cachedData;
  }

  try {
    const freshData = await fetchKnowledgeBase(spreadsheetId);

    cachedData = freshData;
    cacheTimestamp = Date.now();

    return freshData;
  } catch (error) {
    console.error(
      'Knowledge base: failed to fetch from Google Sheets:',
      error.message
    );

    if (cachedData) {
      console.log(
        'Knowledge base: using cached data from previous successful fetch'
      );

      return cachedData;
    }

    console.warn(
      'Knowledge base: no cached data available, returning empty array'
    );

    return [];
  }
}

/**
 * Ищет максимум 3 наиболее релевантные записи.
 */
async function findRelevantEntries(userQuestion, spreadsheetId) {
  if (!userQuestion || userQuestion.trim().length === 0) {
    return [];
  }

  const entries = await getKnowledgeBase(spreadsheetId);

  if (entries.length === 0) {
    return [];
  }

  const questionLower = userQuestion.toLowerCase().trim();

  const words = questionLower
    .split(/\s+/)
    .map((word) => word.replace(/[.,!?;:()"«»]/g, ''))
    .filter((word) => word.length > 2);

  const scored = entries.map((entry) => {
    let score = 0;

    const entryQuestion = entry.question.toLowerCase();
    const entryAnswer = entry.answer.toLowerCase();
    const entryCategory = entry.category.toLowerCase();

    if (
      entryQuestion.includes(questionLower) ||
      questionLower.includes(entryQuestion)
    ) {
      score += 10;
    }

    if (entry.tags) {
      const tags = entry.tags
        .split(/[;,]/)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);

      tags.forEach((tag) => {
        if (
          questionLower.includes(tag) ||
          tag.includes(questionLower)
        ) {
          score += 5;
        }

        words.forEach((word) => {
          if (tag.includes(word)) {
            score += 2;
          }
        });
      });
    }

    if (
      entryCategory.includes(questionLower) ||
      questionLower.includes(entryCategory)
    ) {
      score += 3;
    }

    words.forEach((word) => {
      if (entryQuestion.includes(word)) {
        score += 2;
      }

      if (entryAnswer.includes(word)) {
        score += 1;
      }

      if (entryCategory.includes(word)) {
        score += 1;
      }
    });

    return { entry, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.entry);
}

module.exports = {
  getKnowledgeBase,
  findRelevantEntries
};
