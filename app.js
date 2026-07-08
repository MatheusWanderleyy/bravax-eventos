// ═══════════════════════════════════════════════════════════════
// BRAVAX PROTEGE v3 — app.js
// Filosofia: IA faz o trabalho pesado, atendente só confirma.
// ═══════════════════════════════════════════════════════════════

// ─── CONSTANTES ─────────────────────────────────────────────────
const STORE_KEY  = 'bravax-v3';
const AI_CFG_KEY = 'bravax-ai-cfg';
const CEP        = '51020-280';
const COTAS      = { uber: 7, antigo: 6, novo: 5 };

// ─── ESTADO ─────────────────────────────────────────────────────
let state       = { fornecedores: [], eventos: [] };
let stateRev    = 0;
let currentUser = null;
let loginSetupMode = false;
let savePending = false;
let aiCfg       = loadAiCfg();
let selectedId  = null;
let searchTerm  = '';
let chatHistory = [];
let chatPendingImg  = null; // { base64, url }
let pendingConfirm  = null; // resultado da IA aguardando confirmação
let editingEvtId    = null;
let cotacaoCtx      = null; // { eventoId, pecaId, prefillFornId }
let waCtx           = null; // { eventoId, fornId }

// ─── API / PERSISTÊNCIA NO SERVIDOR ─────────────────────────────
const TOKEN_KEY = 'bravax-token';
const USER_KEY  = 'bravax-user';

async function api(path, opts = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const resp = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (resp.status === 401 && currentUser) { doLogout(); throw new Error('Sessão expirada'); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`);
  return data;
}

let saveTimer = null;
function saveState() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await api('/api/state', { method: 'POST', body: JSON.stringify({ state }) });
      stateRev = r.rev;
      savePending = false;
    } catch (err) {
      console.error('Falha ao salvar:', err.message);
    }
  }, 400);
}

function loadAiCfg() {
  try { const s = localStorage.getItem(AI_CFG_KEY); if (s) return JSON.parse(s); } catch {}
  return { modeloVisao: 'llava', modeloChat: 'llama3.2' };
}
function saveAiCfg() { localStorage.setItem(AI_CFG_KEY, JSON.stringify(aiCfg)); }

// ─── UTILITÁRIOS ────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function moeda(v) {
  return 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function calcCota(evt) {
  if (!evt.fipe) return null;
  return (parseFloat(evt.fipe) * (COTAS[evt.tipo] || 5)) / 100;
}

function computeStatus(evt) {
  if (evt.encerrado) return { label: 'Encerrado', cls: 'green' };
  const ck = evt.checklist || {};
  const done = [ck.comunicou0800, ck.boRealizado, ck.cotaPaga, ck.termoAssociado].filter(Boolean).length;
  if (done === 0) return { label: 'Aberto', cls: 'red' };
  if (done < 4)  return { label: 'Em andamento', cls: 'yellow' };
  return { label: 'Finalizando', cls: 'blue' };
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('A IA não retornou dados estruturados. Tente novamente ou adicione manualmente.');
  return JSON.parse(m[0]);
}

function tipoClass(tipo) {
  const map = { Original: 'original', Paralela: 'paralela', Usada: 'usada', Recondicionada: 'recondicionada' };
  return map[tipo] || 'original';
}

// ─── OLLAMA ─────────────────────────────────────────────────────
async function callOllama(messages, useVision = false) {
  const model = useVision ? (aiCfg.modeloVisao || 'llava') : (aiCfg.modeloChat || 'llama3.2');
  const resp = await fetch('/api/ollama/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Ollama retornou erro ${resp.status}`);
  return data.message?.content ?? '';
}

async function analisarFoto(base64, eventoId) {
  const evt = state.eventos.find(e => e.id === eventoId);
  const pecasExist = evt?.pecas?.map(p => p.nome).join(', ') || 'nenhuma';

  const prompt = `Você é assistente de uma associação de proteção veicular. Analise esta imagem automotiva.
Peças já cadastradas no evento: ${pecasExist}

Retorne SOMENTE um JSON válido neste formato exato:
{
  "tipo": "pecas",
  "fornecedor": null,
  "pecas": [{"nome":"string","quantidade":1,"tipo":"Original","obs":null}],
  "cotacoes": [],
  "info": "resumo do que foi encontrado"
}

Regras:
- tipo = "pecas" → imagem tem lista de peças necessárias (sem preços, ou orçamento de oficina)
- tipo = "cotacao" → imagem tem preços de fornecedor
- tipo = "ambos" → tem lista de peças E preços
- tipo = "outro" → outro tipo de imagem
- Para cotacoes: {"peca":"nome","valor":0.00,"frete":0.00,"prazo":0,"garantia":null,"temPeca":true}
- tipo da peça deve ser: Original, Paralela, Usada ou Recondicionada
- Extraia TUDO que conseguir ler. quantidade = 1 se não visível.`;

  const text = await callOllama([{ role: 'user', content: prompt, images: [base64] }], true);
  return parseJson(text);
}

// ─── RENDER ─────────────────────────────────────────────────────
function renderAll()    { renderList(); renderDetail(); updateAiDot(); }
function renderList()   { _renderList(); }
function renderDetail() { _renderDetail(); }

function updateAiDot() {
  const dot = document.getElementById('aiDot');
  if (!dot) return;
  const configured = !!(aiCfg.modeloVisao || aiCfg.modeloChat);
  dot.textContent = configured ? '●' : '○';
  dot.className = configured ? 'ai-on' : '';
}

// ── Lista de eventos ─────────────────────────────────────────────
function _renderList() {
  const list = document.getElementById('eventList');
  if (!list) return;

  const term = searchTerm.toLowerCase();
  const filtered = state.eventos.filter(e =>
    !term ||
    e.placa.toLowerCase().includes(term) ||
    e.associado.toLowerCase().includes(term) ||
    (e.veiculo || '').toLowerCase().includes(term)
  );

  if (!filtered.length) {
    list.innerHTML = `<div class="list-empty">${term ? 'Nenhum resultado' : 'Nenhum evento'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(evt => {
    const st = computeStatus(evt);
    const nCot = evt.pecas?.reduce((n, p) => n + (p.cotacoes?.length || 0), 0) || 0;
    return `
      <div class="evt-card dot-${st.cls} ${evt.id === selectedId ? 'selected' : ''}"
           onclick="selectEvento('${evt.id}')">
        <div class="evt-top">
          <span class="evt-placa">${evt.placa}</span>
          <span class="evt-dot">${st.label}</span>
        </div>
        <div class="evt-nome">${evt.associado}</div>
        <div class="evt-sub">${evt.veiculo || '—'} · ${evt.pecas?.length || 0}p · ${nCot}q</div>
      </div>`;
  }).join('');
}

// ── Detalhe do evento ────────────────────────────────────────────
function _renderDetail() {
  const panel = document.getElementById('rightPanel');
  if (!panel) return;

  if (!selectedId) {
    panel.innerHTML = `
      <div class="welcome-state">
        <div class="welcome-icon">🚗</div>
        <h2>Bravax Protege</h2>
        <p>Selecione um evento ou crie um novo</p>
        <button class="btn-primary" style="margin-top:8px" onclick="openNovoEvento()">+ Novo Evento</button>
      </div>`;
    return;
  }

  const evt = state.eventos.find(e => e.id === selectedId);
  if (!evt) { selectedId = null; _renderDetail(); return; }

  const st   = computeStatus(evt);
  const cota = calcCota(evt);

  panel.innerHTML = `
    <div class="detail-wrap">

      <button class="btn-back-mobile" onclick="voltarLista()">← Eventos</button>

      <!-- HEADER -->
      <div class="detail-header">
        <div>
          <div class="detail-placa">
            ${evt.placa}
            <span class="badge badge-${st.cls}">${st.label}</span>
          </div>
          <div class="detail-veiculo">${evt.veiculo || '—'}</div>
          <div class="detail-info">
            <span>${evt.associado}</span>
            ${evt.telefone ? `<span>· ${evt.telefone}</span>` : ''}
            ${evt.data ? `<span>· ${new Date(evt.data + 'T12:00:00').toLocaleDateString('pt-BR')}</span>` : ''}
            ${evt.numero ? `<span>· Nº ${evt.numero}</span>` : ''}
          </div>
          ${evt.descricao ? `<div class="detail-descricao">${evt.descricao}</div>` : ''}
        </div>
        <div class="header-actions">
          <button class="hdr-btn" onclick="openEditEvento('${evt.id}')" title="Editar">✏️</button>
          <button class="hdr-btn ${evt.encerrado ? 'success' : ''}"
                  onclick="toggleEncerrado('${evt.id}')"
                  title="${evt.encerrado ? 'Reabrir' : 'Encerrar'}">
            ${evt.encerrado ? '↩' : '✓'}
          </button>
          <button class="hdr-btn danger" onclick="confirmarExcluirEvento('${evt.id}')" title="Excluir">🗑️</button>
        </div>
      </div>

      <!-- COTA DE PARTICIPAÇÃO -->
      ${cota !== null ? `
        <div class="cota-card">
          <div>
            <div class="cota-label">Cota de participação</div>
            <div class="cota-valor">${moeda(cota)}</div>
          </div>
          <div class="cota-detalhe">
            FIPE ${moeda(evt.fipe)} × ${COTAS[evt.tipo]}%<br>
            ${evt.tipo === 'uber' ? 'Uber' : evt.tipo === 'antigo' ? 'Assoc. antigo' : 'Assoc. novo'}
          </div>
        </div>
      ` : ''}

      <!-- CHECKLIST -->
      <div class="checklist-bar">${renderChecklist(evt)}</div>

      <!-- ATUALIZAÇÕES -->
      <div class="section-card">
        <div class="section-toolbar">
          <div class="section-toolbar-left">
            <span class="section-title">Atualizações</span>
            <span class="pecas-count">${evt.atualizacoes?.length || 0}</span>
          </div>
        </div>
        ${renderAtualizacoes(evt)}
        <div class="timeline-input">
          <textarea id="novaAtualizacao" rows="2" placeholder="Escreva a atualização… Ex.: Visitei a oficina hoje, a peça já chegou"></textarea>
          <div class="timeline-btns">
            <button class="btn-ghost-sm" onclick="addAtualizacao('${evt.id}', false)">Salvar</button>
            <button class="btn-wa-save" onclick="addAtualizacao('${evt.id}', true)">💬 Salvar + WhatsApp</button>
          </div>
        </div>
      </div>

      <!-- COMPARATIVO DE PEÇAS -->
      <div class="section-card">
        <div class="section-toolbar">
          <div class="section-toolbar-left">
            <span class="section-title">Comparativo de peças</span>
            <span class="pecas-count">${evt.pecas?.length || 0} peça${evt.pecas?.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="section-toolbar-right">
            <label class="btn-foto" title="Enviar foto — IA extrai peças e cotações automaticamente">
              📷 Enviar foto
              <input type="file" accept="image/*" onchange="handleFotoUpload(event,'${evt.id}')" />
            </label>
            <button class="btn-ghost-sm" onclick="openAddPeca('${evt.id}')">+ Peça</button>
            ${evt.pecas?.length ? `<button class="btn-ghost-sm" onclick="exportar('${evt.id}')">📤 Exportar</button>` : ''}
          </div>
        </div>
        ${renderComparativo(evt)}
      </div>

    </div>`;
}

// ── Checklist ────────────────────────────────────────────────────
function renderChecklist(evt) {
  const ck = evt.checklist || {};
  const items = [
    { key: 'comunicou0800',  label: '0800' },
    { key: 'boRealizado',    label: 'BO' },
    { key: 'cotaPaga',       label: 'Cota paga' },
    { key: 'termoAssociado', label: 'Termo' },
    ...(evt.hasTerceiro ? [{ key: 'termoTerceiro', label: 'Termo 3º' }] : []),
  ];
  return items.map(it => `
    <button class="ck-item ${ck[it.key] ? 'ck-done' : ''}"
            onclick="toggleChecklist('${evt.id}','${it.key}')">
      ${ck[it.key] ? '☑' : '☐'} ${it.label}
    </button>`).join('');
}

// ── Tabela comparativa ───────────────────────────────────────────
function renderComparativo(evt) {
  if (!evt.pecas?.length) {
    return `
      <div class="empty-pecas">
        <div class="ep-icon">📦</div>
        <p>Nenhuma peça adicionada ainda.</p>
        <p>Clique em <strong>📷 Enviar foto</strong> para deixar a IA extrair as peças automaticamente,<br>ou use <strong>+ Peça</strong> para adicionar manualmente.</p>
      </div>`;
  }

  // Fornecedores com cotações neste evento
  const fornSet = new Set();
  evt.pecas.forEach(p => p.cotacoes?.forEach(c => fornSet.add(c.fornecedorId)));
  const fornIds = [...fornSet];
  const forns   = fornIds.map(id => state.fornecedores.find(f => f.id === id)).filter(Boolean);

  let html = '<div class="table-scroll"><table class="comp-table"><thead><tr>';
  html += '<th class="col-peca">Peça</th>';
  html += '<th class="col-qtd">Qtd</th>';

  forns.forEach(f => {
    const waBtn = f.whatsapp
      ? `<button class="btn-wa-mini" onclick="event.stopPropagation();openWA('${evt.id}','${f.id}')">💬 WA</button>`
      : '';
    html += `<th class="col-forn"><div class="th-forn-inner"><span class="th-forn-name">${f.nome}</span>${waBtn}</div></th>`;
  });

  if (forns.length) html += '<th class="col-best">★ Melhor</th>';
  html += '<th class="col-act"></th>';
  html += '</tr></thead><tbody>';

  const totais   = {};
  const totaisOk = {};
  fornIds.forEach(id => { totais[id] = 0; totaisOk[id] = true; });

  evt.pecas.forEach(peca => {
    // Melhor preço para esta peça
    let bestTotal = Infinity, bestFornId = null;
    fornIds.forEach(fId => {
      const c = peca.cotacoes?.find(c => c.fornecedorId === fId);
      if (c?.temPeca && parseFloat(c.valor) > 0) {
        const t = parseFloat(c.valor) * (peca.qtd || 1) + parseFloat(c.frete || 0);
        if (t < bestTotal) { bestTotal = t; bestFornId = fId; }
      }
    });

    const tipoCls = tipoClass(peca.tipo);
    html += `<tr>
      <td class="col-peca">
        <span class="peca-nm">${peca.nome}</span>
        ${peca.obs ? `<span class="peca-sub">${peca.obs}</span>` : ''}
        <span class="tipo-tag tipo-${tipoCls}">${peca.tipo}</span>
      </td>
      <td class="col-qtd">${peca.qtd || 1}</td>`;

    fornIds.forEach(fId => {
      const c = peca.cotacoes?.find(c => c.fornecedorId === fId);
      const isBest = fId === bestFornId;

      if (!c) {
        totaisOk[fId] = false;
        html += `<td class="cell-empty">
          <button class="btn-cotar" onclick="openAddCotacao('${evt.id}','${peca.id}','${fId}')">+ Cotar</button>
        </td>`;
      } else if (!c.temPeca) {
        totaisOk[fId] = false;
        html += `<td class="cell-sem">
          <span>Sem estoque</span>
          <button class="btn-del-cot" onclick="deleteCotacao('${evt.id}','${peca.id}','${c.id}')" title="Remover">✕</button>
        </td>`;
      } else {
        const total = parseFloat(c.valor || 0) * (peca.qtd || 1) + parseFloat(c.frete || 0);
        totais[fId] = (totais[fId] || 0) + total;
        html += `<td class="cell-price ${isBest ? 'cell-best' : ''}">
          <div class="price-val">${isBest ? '<span class="price-star">★</span>' : ''}${moeda(total)}</div>
          <div class="price-det">${moeda(c.valor)} × ${peca.qtd || 1}${parseFloat(c.frete) > 0 ? ` + ${moeda(c.frete)} fr.` : ''}</div>
          ${c.prazo ? `<div class="price-prazo">${c.prazo}d${c.garantia ? ' · ' + c.garantia : ''}</div>` : ''}
          <button class="btn-del-cot" onclick="deleteCotacao('${evt.id}','${peca.id}','${c.id}')" title="Remover cotação">✕</button>
        </td>`;
      }
    });

    // Coluna melhor
    if (forns.length) {
      if (bestFornId) {
        const bf = state.fornecedores.find(f => f.id === bestFornId);
        html += `<td><div class="best-val">${moeda(bestTotal)}</div><div class="best-forn">${bf?.nome || ''}</div></td>`;
      } else {
        html += '<td class="cell-empty">—</td>';
      }
    }

    // Ações
    html += `<td class="col-act">
      <button class="row-act-btn" onclick="openAddCotacao('${evt.id}','${peca.id}',null)" title="Adicionar cotação">＋</button>
      <button class="row-act-btn" onclick="buscarOnline('${evt.id}','${peca.id}')" title="Buscar online">🔍</button>
      <button class="row-act-btn row-act-danger" onclick="deletePeca('${evt.id}','${peca.id}')" title="Remover peça">✕</button>
    </td>`;

    html += '</tr>';
  });

  // Linha de totais
  if (forns.length) {
    html += '<tr class="row-total">';
    html += '<td colspan="2"><strong>Total estimado</strong></td>';
    fornIds.forEach(fId => {
      html += totaisOk[fId] && totais[fId] > 0
        ? `<td><span class="total-val">${moeda(totais[fId])}</span></td>`
        : '<td class="cell-empty">—</td>';
    });
    html += '<td colspan="2"></td></tr>';
  }

  html += '</tbody></table></div>';

  // Dica se não há cotações ainda
  if (!forns.length) {
    html += `<div class="hint-suppliers">
      📋 Peças adicionadas. Agora envie uma <strong>📷 foto</strong> de um orçamento de fornecedor
      ou clique em <strong>+ Cotar</strong> em cada linha para registrar manualmente.
    </div>`;
  }

  return html;
}

// ─── AÇÕES ──────────────────────────────────────────────────────

function selectEvento(id) {
  selectedId = id;
  document.body.classList.add('mobile-detail');
  renderAll();
}

function voltarLista() {
  document.body.classList.remove('mobile-detail');
  renderList();
}

function toggleChecklist(eventoId, key) {
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;
  evt.checklist = evt.checklist || {};
  evt.checklist[key] = !evt.checklist[key];
  saveState(); renderDetail();
}

function toggleEncerrado(eventoId) {
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;
  evt.encerrado = !evt.encerrado;
  saveState(); renderAll();
}

function confirmarExcluirEvento(eventoId) {
  if (!confirm('Excluir este evento? Essa ação não pode ser desfeita.')) return;
  state.eventos = state.eventos.filter(e => e.id !== eventoId);
  if (selectedId === eventoId) selectedId = state.eventos[0]?.id || null;
  saveState(); renderAll();
}

function deletePeca(eventoId, pecaId) {
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;
  evt.pecas = evt.pecas.filter(p => p.id !== pecaId);
  saveState(); renderDetail();
}

function deleteCotacao(eventoId, pecaId, cotId) {
  const peca = state.eventos.find(e => e.id === eventoId)?.pecas?.find(p => p.id === pecaId);
  if (!peca) return;
  peca.cotacoes = peca.cotacoes.filter(c => c.id !== cotId);
  saveState(); renderDetail();
}

function deleteFornecedor(id) {
  state.fornecedores = state.fornecedores.filter(f => f.id !== id);
  saveState(); renderFornecedores();
}

// ─── ABRIR MODAIS ────────────────────────────────────────────────

function openNovoEvento() {
  editingEvtId = null;
  const f = document.getElementById('formEvento');
  f.reset();
  f.data.value = new Date().toISOString().split('T')[0];
  document.getElementById('dlgEventoTitle').textContent = 'Novo Evento';
  document.getElementById('dlgEvento').showModal();
}

function openEditEvento(eventoId) {
  editingEvtId = eventoId;
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;
  const f = document.getElementById('formEvento');
  f.placa.value       = evt.placa || '';
  f.veiculo.value     = evt.veiculo || '';
  f.associado.value   = evt.associado || '';
  f.telefone.value    = evt.telefone || '';
  f.tipo.value        = evt.tipo || 'novo';
  f.fipe.value        = evt.fipe || '';
  f.data.value        = evt.data || '';
  f.descricao.value   = evt.descricao || '';
  f.hasTerceiro.checked = evt.hasTerceiro || false;
  document.getElementById('dlgEventoTitle').textContent = 'Editar Evento';
  document.getElementById('dlgEvento').showModal();
}

function openAddPeca(eventoId) {
  editingEvtId = eventoId;
  document.getElementById('formAddPeca').reset();
  document.getElementById('dlgAddPeca').showModal();
}

function openAddCotacao(eventoId, pecaId, prefillFornId) {
  cotacaoCtx = { eventoId, pecaId, prefillFornId };
  const evt  = state.eventos.find(e => e.id === eventoId);
  const peca = evt?.pecas?.find(p => p.id === pecaId);

  document.getElementById('cotacaoPecaLabel').textContent =
    peca ? `Peça: ${peca.nome} × ${peca.qtd || 1}` : '';

  const sel = document.getElementById('selFornecedorCotacao');
  sel.innerHTML = state.fornecedores.length
    ? state.fornecedores.map(f => `<option value="${f.id}">${f.nome}</option>`).join('')
    : '<option value="">— Nenhum fornecedor cadastrado —</option>';
  if (prefillFornId) sel.value = prefillFornId;

  document.getElementById('formAddCotacao').reset();
  if (prefillFornId) sel.value = prefillFornId;
  document.getElementById('chkTemPeca').checked = true;
  document.getElementById('camposCotacao').style.display = 'contents';

  document.getElementById('dlgAddCotacao').showModal();
}

function openWA(eventoId, fornId) {
  const evt  = state.eventos.find(e => e.id === eventoId);
  const forn = state.fornecedores.find(f => f.id === fornId);
  if (!evt || !forn) return;

  waCtx = { eventoId, fornId };

  // Montar seleção de peças
  const sel = document.getElementById('waSelecaoPecas');
  sel.innerHTML = `<h4>Selecione as peças a cotar</h4>` +
    evt.pecas.map(p => `
      <label class="wa-peca-check">
        <input type="checkbox" class="wa-peca-cb" data-id="${p.id}" checked />
        ${p.nome} (${p.qtd || 1}× ${p.tipo})
      </label>`).join('');

  // Gerar mensagem inicial
  gerarMsgWA(evt, forn, evt.pecas.map(p => p.id));

  // Atualizar mensagem ao mudar seleção
  sel.querySelectorAll('.wa-peca-cb').forEach(cb =>
    cb.addEventListener('change', () => {
      const ids = [...sel.querySelectorAll('.wa-peca-cb:checked')].map(c => c.dataset.id);
      gerarMsgWA(evt, forn, ids);
    })
  );

  document.getElementById('dlgWhatsApp').showModal();
}

function gerarMsgWA(evt, forn, pecaIds) {
  const pecas = evt.pecas.filter(p => pecaIds.includes(p.id));
  const lista = pecas.map(p => `• ${p.nome} (${p.qtd || 1}× ${p.tipo})`).join('\n');
  const msg = `Olá ${forn.nome}! Tudo bem?\n\nPreciso de uma cotação para o veículo abaixo:\n\n🚗 ${evt.veiculo}\n🔑 Placa: ${evt.placa}\n\nPeças necessárias:\n${lista}\n\nFavor informar por peça:\n- Valor unitário\n- Frete para Recife/PE (CEP: ${CEP})\n- Prazo de entrega\n- Garantia\n\nObrigado!`;
  document.getElementById('waPreview').textContent = msg;
}

// ─── FORMULÁRIOS ────────────────────────────────────────────────

function setupForms() {
  // Evento
  document.getElementById('formEvento').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    const dados = {
      placa:       f.placa.value.trim().toUpperCase(),
      veiculo:     f.veiculo.value.trim(),
      associado:   f.associado.value.trim(),
      telefone:    f.telefone.value.trim(),
      tipo:        f.tipo.value,
      fipe:        parseFloat(f.fipe.value.replace(',', '.')) || 0,
      data:        f.data.value,
      descricao:   f.descricao.value.trim(),
      hasTerceiro: f.hasTerceiro.checked,
    };
    if (editingEvtId) {
      Object.assign(state.eventos.find(e => e.id === editingEvtId) || {}, dados);
    } else {
      const num = String(state.eventos.length + 1).padStart(3, '0');
      const novo = {
        id: uid(), numero: `EV-${new Date().getFullYear()}-${num}`,
        encerrado: false, pecas: [],
        checklist: { comunicou0800: false, boRealizado: false, cotaPaga: false, termoAssociado: false, termoTerceiro: false },
        ...dados,
      };
      state.eventos.unshift(novo);
      selectedId = novo.id;
    }
    saveState();
    document.getElementById('dlgEvento').close();
    renderAll();
  });

  // Peça
  document.getElementById('formAddPeca').addEventListener('submit', e => {
    e.preventDefault();
    const f   = e.target;
    const evt = state.eventos.find(ev => ev.id === editingEvtId);
    if (!evt) return;
    evt.pecas.push({
      id: uid(), nome: f.nome.value.trim(),
      qtd: parseInt(f.qtd.value) || 1,
      tipo: f.tipo.value,
      obs: f.obs.value.trim() || '',
      cotacoes: [],
    });
    saveState();
    document.getElementById('dlgAddPeca').close();
    renderDetail();
  });

  // Cotação
  document.getElementById('formAddCotacao').addEventListener('submit', e => {
    e.preventDefault();
    const { eventoId, pecaId } = cotacaoCtx;
    const peca = state.eventos.find(ev => ev.id === eventoId)?.pecas?.find(p => p.id === pecaId);
    if (!peca) return;
    const f     = e.target;
    const fornId = f.fornecedorId.value;
    const temPeca = f.temPeca.checked;
    // Substituir cotação existente do mesmo fornecedor
    peca.cotacoes = peca.cotacoes.filter(c => c.fornecedorId !== fornId);
    peca.cotacoes.push({
      id: uid(), fornecedorId: fornId, temPeca,
      valor:    temPeca ? parseFloat(f.valor.value.replace(',', '.')) || 0 : 0,
      frete:    temPeca ? parseFloat(f.frete.value.replace(',', '.')) || 0 : 0,
      prazo:    temPeca ? parseInt(f.prazo.value) || null : null,
      garantia: temPeca ? f.garantia.value.trim() || '' : '',
    });
    saveState();
    document.getElementById('dlgAddCotacao').close();
    renderDetail();
  });

  document.getElementById('chkTemPeca').addEventListener('change', e => {
    document.getElementById('camposCotacao').style.display = e.target.checked ? 'contents' : 'none';
  });

  // Fornecedor
  document.getElementById('formFornecedor').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target;
    state.fornecedores.push({
      id: uid(),
      nome:     f.nome.value.trim(),
      whatsapp: f.whatsapp.value.replace(/\D/g, ''),
      cidade:   f.cidade.value.trim(),
    });
    saveState(); f.reset(); renderFornecedores();
  });
}

// ─── FORNECEDORES ────────────────────────────────────────────────

function renderFornecedores() {
  const list = document.getElementById('fornecedoresList');
  if (!list) return;
  if (!state.fornecedores.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">Nenhum fornecedor cadastrado.</p>';
    return;
  }
  list.innerHTML = state.fornecedores.map(f => `
    <div class="forn-item">
      <div class="forn-info">
        <strong>${f.nome}</strong>
        ${f.whatsapp ? `<span>${f.whatsapp}</span>` : ''}
        ${f.cidade    ? `<span>${f.cidade}</span>`    : ''}
      </div>
      <button class="btn-icon danger" onclick="deleteFornecedor('${f.id}')">✕</button>
    </div>`).join('');
}

// ─── FOTO ────────────────────────────────────────────────────────

async function handleFotoUpload(event, eventoId) {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  await processarFoto(file, eventoId);
}

async function processarFoto(file, eventoId) {
  const base64 = await fileToBase64(file);

  // Mostrar loading
  const dlg = document.getElementById('dlgFotoConfirm');
  document.getElementById('fotoConfirmTitle').textContent = 'Analisando foto…';
  document.getElementById('fotoConfirmBody').innerHTML = `
    <div class="loading-state"><div class="spinner"></div><p>A IA está lendo a imagem…</p><p style="font-size:12px;color:var(--muted)">Pode levar alguns segundos</p></div>`;
  document.getElementById('btnConfirmarFoto').disabled = true;
  dlg.showModal();

  try {
    const resultado = await analisarFoto(base64, eventoId);
    pendingConfirm = { eventoId, resultado };
    renderFotoConfirm(resultado);
  } catch (err) {
    dlg.close();
    const msg = err.message?.includes('502') || err.message?.toLowerCase().includes('ollama')
      ? 'Ollama não está respondendo.\n\nVerifique:\n1. Ollama está instalado? (ollama.com)\n2. Rode no terminal: ollama run llava\n3. Aguarde carregar e tente novamente.'
      : 'Erro ao analisar a foto:\n' + err.message;
    alert(msg);
  }
}

function renderFotoConfirm(resultado) {
  document.getElementById('fotoConfirmTitle').textContent =
    resultado.tipo === 'pecas'   ? 'Peças extraídas da foto' :
    resultado.tipo === 'cotacao' ? 'Cotação extraída da foto' :
    resultado.tipo === 'ambos'   ? 'Peças e cotações extraídas' :
    'Dados da foto';

  let html = '';

  if (resultado.info) {
    html += `<div class="foto-info">${resultado.info}</div>`;
  }

  // Peças
  if (resultado.pecas?.length) {
    html += `<div class="foto-section"><h4>Peças encontradas — desmarque as que não quiser adicionar</h4>`;
    resultado.pecas.forEach((p, i) => {
      html += `
        <label class="foto-item">
          <input type="checkbox" class="fp-check" data-i="${i}" checked />
          <div class="foto-item-fields">
            <input class="fp-nome" data-i="${i}" value="${p.nome}" placeholder="Nome da peça" />
            <div class="foto-item-row">
              <label>Qtd <input type="number" class="fp-qtd" data-i="${i}" value="${p.quantidade || 1}" min="1" style="width:55px" /></label>
              <label>Tipo
                <select class="fp-tipo" data-i="${i}">
                  ${['Original','Paralela','Usada','Recondicionada'].map(t =>
                    `<option ${t === (p.tipo || 'Original') ? 'selected' : ''}>${t}</option>`
                  ).join('')}
                </select>
              </label>
            </div>
          </div>
        </label>`;
    });
    html += '</div>';
  }

  // Cotações
  if (resultado.cotacoes?.length) {
    const fornNome = resultado.fornecedor || '';
    html += `<div class="foto-section"><h4>Cotações encontradas</h4>
      <div class="foto-forn-select">
        <label>Fornecedor desta cotação
          <select id="fotoFornSelect">
            ${state.fornecedores.map(f =>
              `<option value="${f.id}" ${f.nome.toLowerCase().includes(fornNome.toLowerCase()) && fornNome ? 'selected' : ''}>${f.nome}</option>`
            ).join('')}
            <option value="_novo">+ Cadastrar "${fornNome || 'novo fornecedor'}"</option>
          </select>
        </label>
      </div>`;

    resultado.cotacoes.forEach((c, i) => {
      html += `
        <div class="foto-cotacao">
          <div>
            <div class="foto-cot-peca">${c.peca}</div>
            <div class="foto-cot-label">peça</div>
          </div>
          <div>
            <input type="number" class="fc-valor" data-i="${i}" value="${c.valor || 0}" step="0.01" />
            <div class="foto-cot-label">valor R$</div>
          </div>
          <div>
            <input type="number" class="fc-frete" data-i="${i}" value="${c.frete || 0}" step="0.01" />
            <div class="foto-cot-label">frete R$</div>
          </div>
          <div>
            <input type="number" class="fc-prazo" data-i="${i}" value="${c.prazo || 0}" />
            <div class="foto-cot-label">prazo d.</div>
          </div>
        </div>`;
    });
    html += '</div>';
  }

  if (!resultado.pecas?.length && !resultado.cotacoes?.length) {
    html += `<div class="foto-info warn">⚠️ A IA não identificou peças ou cotações nesta imagem. Tipo detectado: <strong>${resultado.tipo}</strong>. Tente adicionar manualmente.</div>`;
  }

  document.getElementById('fotoConfirmBody').innerHTML = html;
  document.getElementById('btnConfirmarFoto').disabled = false;
}

function confirmarFoto() {
  if (!pendingConfirm) return;
  const { eventoId, resultado } = pendingConfirm;
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;

  // Salvar peças marcadas
  document.querySelectorAll('.fp-check:checked').forEach(cb => {
    const i    = cb.dataset.i;
    const nome = document.querySelector(`.fp-nome[data-i="${i}"]`)?.value?.trim();
    const qtd  = parseInt(document.querySelector(`.fp-qtd[data-i="${i}"]`)?.value) || 1;
    const tipo = document.querySelector(`.fp-tipo[data-i="${i}"]`)?.value || 'Original';
    if (!nome) return;
    if (!evt.pecas.find(p => p.nome.toLowerCase() === nome.toLowerCase())) {
      evt.pecas.push({ id: uid(), nome, qtd, tipo, obs: '', cotacoes: [] });
    }
  });

  // Salvar cotações
  const fornSel = document.getElementById('fotoFornSelect');
  if (fornSel && resultado.cotacoes?.length) {
    let fornId = fornSel.value;
    if (fornId === '_novo') {
      const novoForn = { id: uid(), nome: resultado.fornecedor || 'Fornecedor da foto', whatsapp: '', cidade: '' };
      state.fornecedores.push(novoForn);
      fornId = novoForn.id;
    }
    resultado.cotacoes.forEach((c, i) => {
      const pecaNome = c.peca?.toLowerCase() || '';
      const peca = evt.pecas.find(p =>
        p.nome.toLowerCase().includes(pecaNome) || pecaNome.includes(p.nome.toLowerCase())
      );
      if (!peca) return;
      const valor  = parseFloat(document.querySelector(`.fc-valor[data-i="${i}"]`)?.value) || 0;
      const frete  = parseFloat(document.querySelector(`.fc-frete[data-i="${i}"]`)?.value) || 0;
      const prazo  = parseInt(document.querySelector(`.fc-prazo[data-i="${i}"]`)?.value)  || null;
      peca.cotacoes = peca.cotacoes.filter(ct => ct.fornecedorId !== fornId);
      peca.cotacoes.push({ id: uid(), fornecedorId: fornId, temPeca: valor > 0, valor, frete, prazo, garantia: c.garantia || '' });
    });
  }

  saveState();
  document.getElementById('dlgFotoConfirm').close();
  pendingConfirm = null;
  renderDetail();
}

// ─── DRAG & DROP ────────────────────────────────────────────────

function setupDragDrop() {
  const overlay = document.getElementById('dropOverlay');

  document.addEventListener('dragover', e => {
    e.preventDefault();
    if (selectedId) overlay.classList.remove('hidden');
  });
  document.addEventListener('dragleave', e => {
    if (!e.relatedTarget || !document.contains(e.relatedTarget)) overlay.classList.add('hidden');
  });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    overlay.classList.add('hidden');
    if (!selectedId) return;
    const file = e.dataTransfer.files?.[0];
    if (file?.type.startsWith('image/')) await processarFoto(file, selectedId);
  });
}

// ─── EXPORTAR ────────────────────────────────────────────────────

function exportar(eventoId) {
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;

  const fornSet = new Set();
  evt.pecas.forEach(p => p.cotacoes?.forEach(c => fornSet.add(c.fornecedorId)));
  const forns = [...fornSet].map(id => state.fornecedores.find(f => f.id === id)).filter(Boolean);
  const hoje  = new Date().toLocaleDateString('pt-BR');

  let html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Comparativo ${evt.placa}</title>
<style>
body{font-family:Arial,sans-serif;padding:24px;font-size:13px;color:#111}
h1{font-size:18px;margin-bottom:4px}
.sub{color:#666;margin-bottom:20px;font-size:12px}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #ddd;padding:8px 10px;text-align:left}
th{background:#f3f4f6;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.best{background:#f0fdf4;color:#166534;font-weight:700}
.sem{color:#999;font-style:italic}
.tot{background:#f8f8f8;font-weight:700}
@media print{button{display:none}}
</style></head><body>
<button onclick="window.print()" style="margin-bottom:16px;padding:8px 16px;cursor:pointer;border:1px solid #ddd;border-radius:6px">🖨️ Imprimir</button>
<h1>Comparativo de Peças — ${evt.placa}</h1>
<div class="sub">${evt.veiculo} · ${evt.associado} · Gerado em ${hoje}</div>
<table><thead><tr>
<th>Peça</th><th>Qtd</th>
${forns.map(f => `<th>${f.nome}</th>`).join('')}
<th>★ Melhor</th>
</tr></thead><tbody>`;

  const totais = {};
  forns.forEach(f => totais[f.id] = 0);

  evt.pecas.forEach(p => {
    let best = Infinity, bestId = null;
    forns.forEach(f => {
      const c = p.cotacoes?.find(c => c.fornecedorId === f.id);
      if (c?.temPeca && parseFloat(c.valor) > 0) {
        const t = parseFloat(c.valor) * (p.qtd || 1) + parseFloat(c.frete || 0);
        if (t < best) { best = t; bestId = f.id; }
      }
    });
    html += `<tr><td>${p.nome}${p.obs ? ` (${p.obs})` : ''}</td><td>${p.qtd || 1}</td>`;
    forns.forEach(f => {
      const c = p.cotacoes?.find(c => c.fornecedorId === f.id);
      if (!c) { html += '<td>—</td>'; }
      else if (!c.temPeca) { html += '<td class="sem">Sem estoque</td>'; }
      else {
        const t = parseFloat(c.valor || 0) * (p.qtd || 1) + parseFloat(c.frete || 0);
        totais[f.id] += t;
        html += `<td class="${f.id === bestId ? 'best' : ''}">R$ ${t.toLocaleString('pt-BR',{minimumFractionDigits:2})}${c.prazo ? ` (${c.prazo}d)` : ''}</td>`;
      }
    });
    if (bestId) {
      const bf = forns.find(f => f.id === bestId);
      html += `<td class="best">R$ ${best.toLocaleString('pt-BR',{minimumFractionDigits:2})} — ${bf?.nome}</td>`;
    } else { html += '<td>—</td>'; }
    html += '</tr>';
  });

  html += `<tr class="tot"><td colspan="2">TOTAL</td>
${forns.map(f => `<td>${totais[f.id] > 0 ? 'R$ ' + totais[f.id].toLocaleString('pt-BR',{minimumFractionDigits:2}) : '—'}</td>`).join('')}
<td></td></tr>`;

  html += `</tbody></table><div style="margin-top:20px;font-size:11px;color:#999">Bravax Protege · ${hoje}</div></body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

// ─── BUSCAR ONLINE ────────────────────────────────────────────────

function buscarOnline(eventoId, pecaId) {
  const evt  = state.eventos.find(e => e.id === eventoId);
  const peca = evt?.pecas?.find(p => p.id === pecaId);
  if (!peca) return;
  const q = encodeURIComponent(`${peca.nome} ${evt.veiculo}`);
  // Abre os dois
  window.open(`https://www.google.com/search?q=${q}+Recife&tbm=shop`, '_blank');
}

// ─── WHATSAPP (botão abrir) ───────────────────────────────────────

function abrirWhatsApp() {
  if (!waCtx) return;
  const forn = state.fornecedores.find(f => f.id === waCtx.fornId);
  if (!forn?.whatsapp) return alert('Este fornecedor não tem WhatsApp cadastrado.');
  const msg = document.getElementById('waPreview').textContent;
  const tel = forn.whatsapp.replace(/\D/g, '');
  const num = tel.startsWith('55') ? tel : '55' + tel;
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
  document.getElementById('dlgWhatsApp').close();
}

// ─── CHAT ────────────────────────────────────────────────────────

const CHAT_PROMPT = `Você é um especialista em peças automotivas com 20+ anos de experiência no mercado brasileiro.
Auxilia atendentes da Bravax Protege, uma associação de proteção veicular.
Seja direto e prático. Responda em português brasileiro simples.
Para cada avaliação dê uma recomendação clara: APROVAR, QUESTIONAR ou REJEITAR.
Se analisar imagem de anúncio: leia tudo, inclua o "miúdo", aponte inconsistências, verifique compatibilidade.
Máximo 6 linhas por resposta — seja objetivo.`;

async function sendChat() {
  const textarea = document.getElementById('cwText');
  const text     = textarea.value.trim();
  const img      = chatPendingImg;
  if (!text && !img) return;

  textarea.value = '';
  appendChat('user', text, img?.url);
  chatPendingImg = null;
  document.getElementById('cwImgWrap').classList.add('hidden');

  const userMsg = { role: 'user', content: text };
  if (img) userMsg.images = [img.base64];
  chatHistory.push(userMsg);

  const messages = [{ role: 'system', content: CHAT_PROMPT }, ...chatHistory];
  const typId = 'typ_' + Date.now();
  appendChat('typing', '', null, typId);

  try {
    const resp = await callOllama(messages, !!img);
    document.getElementById(typId)?.remove();
    appendChat('ai', resp);
    chatHistory.push({ role: 'assistant', content: resp });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  } catch (err) {
    document.getElementById(typId)?.remove();
    appendChat('error', err.message);
  }
}

function appendChat(role, text, imgUrl, id) {
  const msgs = document.getElementById('cwMessages');
  const div  = document.createElement('div');
  if (id) div.id = id;

  if (role === 'typing') {
    div.className = 'cw-msg cw-msg-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
  } else if (role === 'error') {
    div.className = 'cw-msg cw-msg-error';
    div.textContent = '⚠️ ' + text;
  } else {
    div.className = `cw-msg cw-msg-${role === 'user' ? 'user' : 'ai'}`;
    if (imgUrl) {
      const img = document.createElement('img');
      img.src = imgUrl; img.className = 'cw-msg-img';
      div.appendChild(img);
    }
    if (text) {
      const p = document.createElement('p'); p.textContent = text; div.appendChild(p);
    }
  }
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ─── DIALOGS GENÉRICO ────────────────────────────────────────────

function setupDialogs() {
  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => document.getElementById(btn.dataset.close)?.close())
  );
  document.querySelectorAll('dialog').forEach(dlg =>
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); })
  );
}

// ─── LISTENERS ──────────────────────────────────────────────────

function setupListeners() {
  document.getElementById('btnNovoEvento')?.addEventListener('click', openNovoEvento);

  document.getElementById('searchInput')?.addEventListener('input', e => {
    searchTerm = e.target.value.trim(); renderList();
  });

  document.getElementById('btnFornecedores')?.addEventListener('click', () => {
    renderFornecedores(); document.getElementById('dlgFornecedores').showModal();
  });

  // Login
  document.getElementById('btnLogin')?.addEventListener('click', fazerLogin);
  document.getElementById('loginPin')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') fazerLogin();
  });
  document.getElementById('btnSair')?.addEventListener('click', doLogout);

  // Operadores
  document.getElementById('btnOperadores')?.addEventListener('click', () => {
    renderOperadores(); document.getElementById('dlgOperadores').showModal();
  });
  document.getElementById('formOperador')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/operadores', {
        method: 'POST',
        body: JSON.stringify({ nome: f.nome.value.trim(), pin: f.pin.value.trim() }),
      });
      f.reset();
      renderOperadores();
    } catch (err) { alert(err.message); }
  });


  document.getElementById('btnConfigIA')?.addEventListener('click', () => {
    document.getElementById('modeloVisao').value = aiCfg.modeloVisao || 'llava';
    document.getElementById('modeloChat').value  = aiCfg.modeloChat  || 'llama3.2';
    document.getElementById('iaStatus').textContent = '';
    document.getElementById('iaStatus').className   = 'ia-status';
    document.getElementById('dlgConfigIA').showModal();
  });

  document.getElementById('btnSalvarIA')?.addEventListener('click', () => {
    aiCfg.modeloVisao = document.getElementById('modeloVisao').value.trim() || 'llava';
    aiCfg.modeloChat  = document.getElementById('modeloChat').value.trim()  || 'llama3.2';
    saveAiCfg(); document.getElementById('dlgConfigIA').close(); updateAiDot();
  });

  document.getElementById('btnTestarIA')?.addEventListener('click', async () => {
    const st = document.getElementById('iaStatus');
    st.textContent = 'Testando…'; st.className = 'ia-status';
    try {
      await callOllama([{ role: 'user', content: 'Olá' }], false);
      st.textContent = '✓ Ollama OK! Conexão funcionando.'; st.className = 'ia-status ia-ok';
    } catch (err) {
      st.textContent = '✗ ' + err.message; st.className = 'ia-status ia-error';
    }
  });


  // Chat
  document.getElementById('btnChat')?.addEventListener('click', () =>
    document.getElementById('chatWidget').classList.toggle('hidden')
  );
  document.getElementById('btnCloseChat')?.addEventListener('click', () =>
    document.getElementById('chatWidget').classList.add('hidden')
  );
  document.getElementById('btnSend')?.addEventListener('click', sendChat);
  document.getElementById('cwText')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.getElementById('cwFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return; e.target.value = '';
    const base64 = await fileToBase64(file);
    chatPendingImg = { base64, url: URL.createObjectURL(file) };
    document.getElementById('cwImgPreview').src = chatPendingImg.url;
    document.getElementById('cwImgWrap').classList.remove('hidden');
  });
  document.getElementById('btnRemoveCwImg')?.addEventListener('click', () => {
    chatPendingImg = null;
    document.getElementById('cwImgWrap').classList.add('hidden');
    document.getElementById('cwImgPreview').src = '';
  });

  // Foto confirm
  document.getElementById('btnConfirmarFoto')?.addEventListener('click', confirmarFoto);

  // WhatsApp
  document.getElementById('btnAbrirWA')?.addEventListener('click', abrirWhatsApp);
}

// ─── ATUALIZAÇÕES (timeline) ─────────────────────────────────────

function renderAtualizacoes(evt) {
  const ats = [...(evt.atualizacoes || [])].reverse();
  if (!ats.length) return '<div class="tl-empty">Nenhuma atualização ainda. Registre aqui visitas, contatos e andamentos.</div>';
  return '<div class="timeline">' + ats.map(a => {
    const d = new Date(a.data);
    const quando = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
                   d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="tl-item">
        <div class="tl-head">
          <strong>${a.autor}</strong><span>${quando}</span>
          <div class="tl-actions">
            <button class="row-act-btn" onclick="enviarAtualizacaoWA('${evt.id}','${a.id}')" title="Enviar no WhatsApp">📤</button>
            <button class="row-act-btn row-act-danger" onclick="delAtualizacao('${evt.id}','${a.id}')" title="Excluir">✕</button>
          </div>
        </div>
        <div class="tl-text">${a.texto}</div>
      </div>`;
  }).join('') + '</div>';
}

function addAtualizacao(eventoId, enviarWA) {
  const ta = document.getElementById('novaAtualizacao');
  const texto = ta?.value.trim();
  if (!texto) return;
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;
  evt.atualizacoes = evt.atualizacoes || [];
  const at = { id: uid(), autor: currentUser?.nome || '—', data: new Date().toISOString(), texto };
  evt.atualizacoes.push(at);
  saveState();
  renderDetail();
  if (enviarWA) enviarAtualizacaoWA(eventoId, at.id);
}

function delAtualizacao(eventoId, atId) {
  const evt = state.eventos.find(e => e.id === eventoId);
  if (!evt) return;
  evt.atualizacoes = (evt.atualizacoes || []).filter(a => a.id !== atId);
  saveState();
  renderDetail();
}

function enviarAtualizacaoWA(eventoId, atId) {
  const evt = state.eventos.find(e => e.id === eventoId);
  const at  = evt?.atualizacoes?.find(a => a.id === atId);
  if (!at) return;
  const d = new Date(at.data);
  const quando = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
                 d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const msg = `🔔 *ATUALIZAÇÃO DE EVENTO*\n\n🚗 ${evt.veiculo} — ${evt.placa}\n👤 ${evt.associado}\n📋 ${evt.numero}\n\n📝 ${at.texto}\n\n— ${at.autor}, ${quando}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
}

// ─── LOGIN ───────────────────────────────────────────────────────

async function mostrarLogin() {
  document.getElementById('loginScreen').classList.remove('hidden');
  const erro = document.getElementById('loginErro');
  try {
    const r = await api('/api/operadores');
    const sel = document.getElementById('loginNome');
    if (r.setup) {
      loginSetupMode = true;
      document.getElementById('loginTitulo').textContent = 'Primeiro acesso — crie o primeiro operador';
      sel.classList.add('hidden');
      document.getElementById('loginNomeNovo').classList.remove('hidden');
      document.getElementById('btnLogin').textContent = 'Criar e entrar';
    } else {
      loginSetupMode = false;
      sel.innerHTML = r.operadores.map(n => `<option>${n}</option>`).join('');
      const salvo = localStorage.getItem(USER_KEY);
      if (salvo && r.operadores.includes(salvo)) sel.value = salvo;
    }
  } catch {
    erro.textContent = 'Servidor indisponível. Recarregue a página.';
  }
}

async function fazerLogin() {
  const erro = document.getElementById('loginErro');
  erro.textContent = '';
  const pin  = document.getElementById('loginPin').value.trim();
  const nome = loginSetupMode
    ? document.getElementById('loginNomeNovo').value.trim()
    : document.getElementById('loginNome').value;
  if (!nome || pin.length < 4) { erro.textContent = 'Informe nome e PIN de 4 a 6 dígitos'; return; }
  try {
    if (loginSetupMode) {
      await api('/api/operadores', { method: 'POST', body: JSON.stringify({ nome, pin }) });
    }
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ nome, pin }) });
    localStorage.setItem(TOKEN_KEY, r.token);
    localStorage.setItem(USER_KEY, r.nome);
    currentUser = { nome: r.nome };
    document.getElementById('loginPin').value = '';
    await carregarDados();
    entrarNoApp();
  } catch (err) {
    erro.textContent = err.message;
  }
}

function doLogout() {
  localStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  location.reload();
}

async function carregarDados() {
  const r = await api('/api/state');
  state = r.state && r.state.eventos ? r.state : { fornecedores: [], eventos: [] };
  stateRev = r.rev || 0;
  await migrarDadosLocais();
}

// Migra dados antigos do navegador para o servidor (uma única vez)
async function migrarDadosLocais() {
  try {
    if (state.eventos.length) return;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const local = JSON.parse(raw);
    if (!local?.eventos?.length) return;
    state = local;
    const r = await api('/api/state', { method: 'POST', body: JSON.stringify({ state }) });
    stateRev = r.rev;
  } catch {}
}

function entrarNoApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('userTag').textContent = `👤 ${currentUser.nome}`;
  selectedId = state.eventos[0]?.id ?? null;
  renderAll();
  iniciarPolling();
}

// Busca mudanças feitas por outros operadores a cada 20s
let pollingAtivo = false;
function iniciarPolling() {
  if (pollingAtivo) return;
  pollingAtivo = true;
  setInterval(async () => {
    if (savePending || document.querySelector('dialog[open]')) return;
    try {
      const r = await api('/api/state');
      if (r.rev > stateRev) {
        state = r.state;
        stateRev = r.rev;
        renderAll();
      }
    } catch {}
  }, 20000);
}

// ─── OPERADORES ──────────────────────────────────────────────────

async function renderOperadores() {
  const list = document.getElementById('operadoresList');
  list.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">Carregando…</p>';
  try {
    const r = await api('/api/operadores');
    list.innerHTML = r.operadores.map(n => `
      <div class="forn-item">
        <div class="forn-info">
          <strong>${n}</strong>
          ${n === currentUser?.nome ? '<span>você</span>' : ''}
        </div>
        <button class="btn-icon danger" onclick="removerOperador('${n.replace(/'/g, "\\'")}')">✕</button>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p style="color:var(--red);font-size:13px">${err.message}</p>`;
  }
}

async function removerOperador(nome) {
  if (!confirm(`Remover o operador ${nome}?`)) return;
  try {
    await api(`/api/operadores?nome=${encodeURIComponent(nome)}`, { method: 'DELETE' });
    renderOperadores();
  } catch (err) { alert(err.message); }
}

// ─── INIT ────────────────────────────────────────────────────────

async function init() {
  setupDialogs();
  setupForms();
  setupListeners();
  setupDragDrop();
  updateAiDot();

  // Sessão salva? Entra direto. Senão, tela de login.
  const token = localStorage.getItem(TOKEN_KEY);
  const nome  = localStorage.getItem(USER_KEY);
  if (token && nome) {
    currentUser = { nome };
    try {
      await carregarDados();
      entrarNoApp();
      return;
    } catch {
      currentUser = null;
    }
  }
  mostrarLogin();
}

document.addEventListener('DOMContentLoaded', init);
