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
const ROTEIROS_PATH = path.join(userData, 'roteiros');

if (!fs.existsSync(ROTEIROS_PATH)) {
    fs.mkdirSync(ROTEIROS_PATH, { recursive: true });
}

const db = new sqlite3(DB_PATH);

/*
* BANCO DE DADOS
*/
db.exec(`
    CREATE TABLE IF NOT EXISTS documentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arquivo TEXT UNIQUE,
        tipo TEXT,
        titulo TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS documentos_busca USING fts5(
        documento_id UNINDEXED,
        titulo,
        conteudo
    );
`);

async function indexarArquivo(nomeArquivo) {
    const extensao = path.extname(nomeArquivo).toLowerCase().replace('.', '');
    if (extensao !== 'md' && extensao !== 'pdf') return;

    const existe = db.prepare("SELECT id FROM documentos WHERE arquivo = ?").get(nomeArquivo);
    if (existe) return;

    const caminhoCompleto = path.join(ROTEIROS_PATH, nomeArquivo);
    const nomeSemExtensao = path.basename(nomeArquivo, path.extname(nomeArquivo));
    
    const titulo = nomeSemExtensao
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());

    let textoExtraido = '';

    try {
        if (extensao === 'md') {
            textoExtraido = fs.readFileSync(caminhoCompleto, 'utf-8');
        } else if (extensao === 'pdf') {
            const dataBuffer = fs.readFileSync(caminhoCompleto);
            const data = await pdfParse(dataBuffer);
            textoExtraido = data.text || '';
        }

        const insertDoc = db.prepare("INSERT INTO documentos (arquivo, tipo, titulo) VALUES (?, ?, ?)");
        const info = insertDoc.run(nomeArquivo, extensao, titulo);
        const docId = info.lastInsertRowid;

        const insertFts = db.prepare("INSERT INTO documentos_busca (documento_id, titulo, conteudo) VALUES (?, ?, ?)");
        insertFts.run(docId, titulo, textoExtraido);
        
        console.log(`[Indexador] Sucesso ao indexar: ${nomeArquivo}`);
    } catch (err) {
        console.error(`[Indexador] Erro ao processar ${nomeArquivo}:`, err);
    }
}

async function sincronizarDiretorio() {
    try {
        const arquivosNaPasta = fs.readdirSync(ROTEIROS_PATH);
        for (const arquivo of arquivosNaPasta) {
            const caminhoFisico = path.join(ROTEIROS_PATH, arquivo);
            if (fs.statSync(caminhoFisico).isFile()) {
                await indexarArquivo(arquivo);
            }
        }
    } catch (err) {
        console.error("Erro na sincronização inicial:", err);
    }
}
sincronizarDiretorio();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, ROTEIROS_PATH);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

appExpress.use('/roteiros', express.static(ROTEIROS_PATH));
appExpress.use('/assets', express.static(path.join(__dirname, 'assets')));
appExpress.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
//appExpress.use(express.json());

appExpress.use(express.json({ limit: '50mb' }));
appExpress.use(express.urlencoded({ limit: '50mb', extended: true }));

/*
* ROTAS
*/

appExpress.get('/search', (req, res) => {
    let termo = (req.query.busca || '').trim();
    if (!termo) {
        return res.json([]);
    }

    termo = termo.replace(/\s+/g, ' ');
    const palavras = termo.split(' ');
    termo = palavras.join(' OR ');

    try {
        const stmt = db.prepare(`
            SELECT 
                d.arquivo,
                d.titulo,
                d.tipo,
                bm25(documentos_busca) AS score
            FROM documentos d
            JOIN documentos_busca b ON d.id = b.documento_id
            WHERE documentos_busca MATCH ?
            ORDER BY score ASC
            LIMIT 50
        `);
        const result = stmt.all(termo);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Erro interno ao buscar" });
    }
});

appExpress.get('/documentos', (req, res) => {
    try {
        const docs = db.prepare(`SELECT arquivo, titulo, tipo FROM documentos`).all();
        
        const result = {};
        docs.forEach(row => {
            const caminhoCompleto = path.join(ROTEIROS_PATH, row.arquivo);
            let htmlConteudo = '';

            if (row.tipo === 'md' && fs.existsSync(caminhoCompleto)) {
                const markdownBruto = fs.readFileSync(caminhoCompleto, 'utf-8');
                htmlConteudo = marked.parse(markdownBruto);
            } else if (row.tipo === 'html' && fs.existsSync(caminhoCompleto)) {
                htmlConteudo = fs.readFileSync(caminhoCompleto, 'utf-8');
            } else if (row.tipo === 'pdf') {
                htmlConteudo = `<iframe src="http://localhost:3000/roteiros/${encodeURIComponent(row.arquivo)}" width="100%" height="750px" style="border:none;"></iframe>`;
            }

            result[row.arquivo] = {
                titulo: row.titulo,
                html: htmlConteudo,
                tipo: row.tipo
            };
        });

        res.json(result);
    } catch (error) {
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

    await indexarArquivo(req.file.originalname);

    res.json({ status: 'OK', arquivo: req.file.originalname });
});

appExpress.delete('/documentos/:arquivo', (req, res) => {
    const nomeArquivo = req.params.arquivo;
    const caminhoCompleto = path.join(ROTEIROS_PATH, nomeArquivo);

    try {
        const doc = db.prepare("SELECT id FROM documentos WHERE arquivo = ?").get(nomeArquivo);
        
        if (!doc) {
            return res.status(404).json({ error: "Documento não encontrado no banco de dados." });
        }

        const deletarFts = db.prepare("DELETE FROM documentos_busca WHERE documento_id = ?");
        const deletarDoc = db.prepare("DELETE FROM documentos WHERE id = ?");

        deletarFts.run(doc.id);
        deletarDoc.run(doc.id);

        if (fs.existsSync(caminhoCompleto)) {
            fs.unlinkSync(caminhoCompleto);
        }

        console.log(`[Server] Arquivo e dados removidos com sucesso: ${nomeArquivo}`);
        res.json({ status: "OK", mensagem: "Removido com sucesso" });

    } catch (error) {
        console.error("Erro ao deletar documento:", error);
        res.status(500).json({ error: "Erro interno ao tentar remover o arquivo." });
    }
});

appExpress.post('/documentos', (req, res) => {
    const { arquivo, titulo, html } = req.body;

    if (!arquivo || !titulo || !html) {
        return res.status(400).json({ error: "Dados incompletos para criação." });
    }

    try {
        const caminhoFisico = path.join(ROTEIROS_PATH, arquivo);
        fs.writeFileSync(caminhoFisico, html, 'utf-8');

        const insertDoc = db.prepare("INSERT INTO documentos (arquivo, tipo, titulo) VALUES (?, ?, ?)");
        const info = insertDoc.run(arquivo, 'html', titulo);
        const docId = info.lastInsertRowid;
        const textoPuro = html.replace(/<[^>]*>/g, ' ');
        const insertFts = db.prepare("INSERT INTO documentos_busca (documento_id, titulo, conteudo) VALUES (?, ?, ?)");
        insertFts.run(docId, titulo, textoPuro);

        res.json({ status: "OK", arquivo });
    } catch (error) {
        console.error("Erro ao criar roteiro:", error);
        res.status(500).json({ error: "Erro interno ao criar roteiro." });
    }
});

appExpress.put('/documentos/:arquivo', (req, res) => {
    const nomeArquivo = req.params.arquivo;
    const { html } = req.body;

    if (!html) {
        return res.status(400).json({ error: "Conteúdo vazio." });
    }

    try {
        const caminhoFisico = path.join(ROTEIROS_PATH, nomeArquivo);
        fs.writeFileSync(caminhoFisico, html, 'utf-8');

        const doc = db.prepare("SELECT id, titulo FROM documentos WHERE arquivo = ?").get(nomeArquivo);
        if (!doc) {
            return res.status(404).json({ error: "Documento não encontrado no banco." });
        }

        const textoPuro = html.replace(/<[^>]*>/g, ' ');
        const updateFts = db.prepare("UPDATE documentos_busca SET conteudo = ? WHERE documento_id = ?");
        updateFts.run(textoPuro, doc.id);

        res.json({ status: "OK", mensagem: "Roteiro atualizado com sucesso." });
    } catch (error) {
        console.error("Erro ao atualizar roteiro:", error);
        res.status(500).json({ error: "Erro interno ao atualizar roteiro." });
    }
});

const PORT = 3000;
appExpress.listen(PORT, () => {
    console.log(`Server rodando na porta ${PORT}`);
});