/*
* ROTAS - SERVICES - DB - ROTEIROS
*/
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const sqlite3 = require('better-sqlite3');
const { marked } = require('marked');
const pdfParse = require('pdf-parse-fork');

const appExpress = express();

/*
* CONFIGURAÇÕES DE DIRETÓRIOS E BANCO DE DADOS
*/
const userData = process.argv.find(arg => arg.startsWith('--user-data='))
    ? process.argv.find(arg => arg.startsWith('--user-data=')).split('=')[1]
    : path.join(process.env.APPDATA || process.env.HOME, 'central-roteiros');

const DB_PATH = path.join(userData, 'database.db');

const PDF_CACHE_PATH = path.join(userData, 'pdf_cache');
if (!fs.existsSync(PDF_CACHE_PATH)) {
    fs.mkdirSync(PDF_CACHE_PATH, { recursive: true });
}

const db = new sqlite3(DB_PATH);

/*
* BANCO DE DADOS (SQLite-First com migração automática)
*/
db.exec(`
    CREATE TABLE IF NOT EXISTS documentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arquivo TEXT UNIQUE, -- Chave de identificação no front-end
        tipo TEXT,           -- 'html', 'md', 'pdf'
        titulo TEXT,
        conteudo TEXT,       -- Conteúdo real do arquivo (HTML bruto ou Markdown)
        categoria TEXT DEFAULT 'roteiros'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documentos_busca USING fts5(
        documento_id UNINDEXED,
        titulo,
        conteudo,
        tokenize = "unicode61 remove_diacritics 1"
    );
`);

try {
    const infoTabela = db.prepare("PRAGMA table_info(documentos)").all();
    
    const temCategoria = infoTabela.some(col => col.name === 'categoria');
    if (!temCategoria) {
        db.exec("ALTER TABLE documentos ADD COLUMN categoria TEXT DEFAULT 'roteiros'");
        console.log("[DB] Coluna 'categoria' adicionada.");
    }

    const temConteudo = infoTabela.some(col => col.name === 'conteudo');
    if (!temConteudo) {
        db.exec("ALTER TABLE documentos ADD COLUMN conteudo TEXT");
        console.log("[DB] Coluna 'conteudo' adicionada para suporte offline completo.");
    }
} catch (e) {
    console.error("[DB] Erro ao atualizar estrutura da tabela:", e);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, PDF_CACHE_PATH);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

appExpress.use('/pdfs', express.static(PDF_CACHE_PATH));

appExpress.use('/assets', express.static(path.join(__dirname, 'assets')));
appExpress.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

appExpress.use(express.json({ limit: '50mb' }));
appExpress.use(express.urlencoded({ limit: '50mb', extended: true }));

/*
* MECANISMO DE BUSCA FTS5
*/
const STOPWORDS_PT = new Set([
    'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas',
    'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
    'por', 'pra', 'para', 'com', 'sem', 'sobre', 'sob', 'entre',
    'e', 'ou', 'mas', 'que', 'se', 'ao', 'aos', 'à', 'às',
    'é', 'foi', 'ser', 'está', 'esta', 'este', 'isso', 'isto', 'me',
    'meu', 'minha', 'seu', 'sua', 'no', 'na', 'pelo', 'pela'
]);
 
function montarQueryFts(termo) {
    const palavras = termo
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .map(p => p.replace(/"/g, ''))
        .filter(p => p.length > 0);
 
    if (palavras.length === 0) return '';
 
    const palavrasRelevantes = palavras.filter(p => !STOPWORDS_PT.has(p.toLowerCase()));
    const palavrasFinais = palavrasRelevantes.length > 0 ? palavrasRelevantes : palavras;
 
    return palavrasFinais.map(p => `${p}*`).join(' OR ');
}
 
appExpress.get('/search', (req, res) => {
    let termo = (req.query.busca || '').trim();
    let categoria = req.query.categoria || 'roteiros'; 
    if (!termo) {
        return res.json([]);
    }
 
    const termoFts = montarQueryFts(termo);
    if (!termoFts) {
        return res.json([]);
    }
 
    try {
        const stmt = db.prepare(`
            SELECT 
                d.arquivo,
                d.titulo,
                d.tipo,
                d.categoria,
                bm25(documentos_busca, 5.0, 1.0) AS score
            FROM documentos d
            JOIN documentos_busca b ON d.id = b.documento_id
            WHERE documentos_busca MATCH ? AND d.categoria = ?
            ORDER BY score ASC 
            LIMIT 50
        `);
        
        const result = stmt.all(termoFts, categoria);
        res.json(result);
    } catch (error) {
        console.error("Erro na busca:", error);
        res.status(500).json({ error: "Erro interno ao buscar" });
    }
});

/*
* ROTAS DA API - DOCUMENTOS (SQLite-First)
*/

appExpress.get('/documentos', (req, res) => {
    const categoria = req.query.categoria || 'roteiros';
    try {
        const docs = db.prepare(`SELECT arquivo, titulo, tipo, conteudo, categoria FROM documentos WHERE categoria = ?`).all(categoria);
        
        const result = {};
        docs.forEach(row => {
            let htmlConteudo = '';

            if (row.tipo === 'md') {
                htmlConteudo = marked.parse(row.conteudo || '');
            } else if (row.tipo === 'html') {
                htmlConteudo = row.conteudo || '';
            } else if (row.tipo === 'pdf') {
                // PDFs são renderizados apontando para a pasta física de cache estático
                htmlConteudo = `<iframe src="http://localhost:3000/pdfs/${encodeURIComponent(row.arquivo)}" width="100%" height="750px" style="border:none;"></iframe>`;
            }

            result[row.arquivo] = {
                titulo: row.titulo,
                html: htmlConteudo,
                tipo: row.tipo,
                categoria: row.categoria
            };
        });

        res.json(result);
    } catch (error) {
        console.error("Erro ao listar documentos:", error);
        res.status(500).json({ error: "Erro ao listar documentos" });
    }
});
    
appExpress.post('/upload', upload.single('pdf'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.pdf') {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Arquivo não é um PDF' });
    }

    const nomeArquivo = req.file.originalname;
    const categoria = req.body.categoria || req.query.categoria || 'roteiros';

    try {
        const existe = db.prepare("SELECT id FROM documentos WHERE arquivo = ?").get(nomeArquivo);
        if (existe) {
            return res.status(400).json({ error: 'Este PDF já existe no banco.' });
        }

        const caminhoPdf = path.join(PDF_CACHE_PATH, nomeArquivo);
        const dataBuffer = fs.readFileSync(caminhoPdf);
        const parsedPdf = await pdfParse(dataBuffer);
        const textoExtraido = parsedPdf.text || '';

        const titulo = path.basename(nomeArquivo, ext)
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, l => l.toUpperCase());

        const transacaoUpload = db.transaction(() => {
            const info = db.prepare("INSERT INTO documentos (arquivo, tipo, titulo, conteudo, categoria) VALUES (?, 'pdf', ?, ?, ?)")
                .run(nomeArquivo, titulo, textoExtraido, categoria);
            
            db.prepare("INSERT INTO documentos_busca (documento_id, titulo, conteudo) VALUES (?, ?, ?)")
                .run(info.lastInsertRowid, titulo, textoExtraido);
        });
        
        transacaoUpload();

        console.log(`[Upload] PDF ${nomeArquivo} salvo e indexado com sucesso na categoria ${categoria}.`);
        res.json({ status: 'OK', arquivo: nomeArquivo });

    } catch (err) {
        console.error("[Upload] Erro ao indexar PDF:", err);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Erro interno ao indexar arquivo' });
    }
});

appExpress.delete('/documentos/:arquivo', (req, res) => {
    const nomeArquivo = req.params.arquivo;
    const categoria = req.query.categoria || 'roteiros';

    try {
        const doc = db.prepare("SELECT id, tipo FROM documentos WHERE arquivo = ? AND categoria = ?").get(nomeArquivo, categoria);
        
        if (!doc) {
            return res.status(404).json({ error: "Documento não encontrado no banco de dados." });
        }

        const removerTransacao = db.transaction(() => {
            db.prepare("DELETE FROM documentos_busca WHERE documento_id = ?").run(doc.id);
            db.prepare("DELETE FROM documentos WHERE id = ?").run(doc.id);
        });

        removerTransacao();

        if (doc.tipo === 'pdf') {
            const caminhoFisico = path.join(PDF_CACHE_PATH, nomeArquivo);
            if (fs.existsSync(caminhoFisico)) {
                fs.unlinkSync(caminhoFisico);
            }
        }

        console.log(`[Server] Item removido da categoria ${categoria}: ${nomeArquivo}`);
        res.json({ status: "OK", mensagem: "Removido com sucesso" });

    } catch (error) {
        console.error("Erro ao deletar documento:", error);
        res.status(500).json({ error: "Erro interno ao tentar remover o arquivo." });
    }
});

appExpress.post('/documentos', (req, res) => {
    const { arquivo, titulo, html } = req.body;
    const categoria = req.query.categoria || 'roteiros';

    if (!arquivo || !titulo || !html) {
        return res.status(400).json({ error: "Dados incompletos para criação." });
    }

    try {
        const textoPuro = html.replace(/<[^>]*>/g, ' ');

        const salvarTransacao = db.transaction(() => {
            const info = db.prepare("INSERT INTO documentos (arquivo, tipo, titulo, conteudo, categoria) VALUES (?, 'html', ?, ?, ?)")
                .run(arquivo, titulo, html, categoria);
            
            db.prepare("INSERT INTO documentos_busca (documento_id, titulo, conteudo) VALUES (?, ?, ?)")
                .run(info.lastInsertRowid, titulo, textoPuro);
        });

        salvarTransacao();
        res.json({ status: "OK", arquivo });
    } catch (error) {
        console.error("Erro ao criar item:", error);
        res.status(500).json({ error: "Erro interno ao criar item." });
    }
});

appExpress.put('/documentos/:arquivo', (req, res) => {
    const nomeArquivo = req.params.arquivo;
    const { html } = req.body;
    const categoria = req.query.categoria || 'roteiros';

    if (!html) {
        return res.status(400).json({ error: "Conteúdo vazio." });
    }

    try {
        const doc = db.prepare("SELECT id, titulo FROM documentos WHERE arquivo = ? AND categoria = ?").get(nomeArquivo, categoria);
        if (!doc) {
            return res.status(404).json({ error: "Documento não encontrado no banco." });
        }

        const textoPuro = html.replace(/<[^>]*>/g, ' ');

        const atualizarTransacao = db.transaction(() => {
            db.prepare("UPDATE documentos SET conteudo = ? WHERE id = ?")
                .run(html, doc.id);
            db.prepare("UPDATE documentos_busca SET conteudo = ? WHERE documento_id = ?")
                .run(textoPuro, doc.id);
        });

        atualizarTransacao();
        res.json({ status: "OK", mensagem: "Item atualizado com sucesso." });
    } catch (error) {
        console.error("Erro ao atualizar item:", error);
        res.status(500).json({ error: "Erro interno ao atualizar item." });
    }
});

const PORT = 3000;
appExpress.listen(PORT, () => {
    console.log(`Server rodando na porta ${PORT}`);
});