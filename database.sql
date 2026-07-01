CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE associados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  cpf_cnpj TEXT,
  telefone TEXT,
  email TEXT,
  tipo_associado TEXT NOT NULL CHECK (tipo_associado IN ('uber', 'antigo', 'novo')),
  data_entrada DATE,
  status TEXT DEFAULT 'ativo',
  observacoes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE veiculos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  associado_id UUID REFERENCES associados(id),
  placa TEXT NOT NULL,
  marca TEXT,
  modelo TEXT,
  ano INTEGER,
  valor_fipe NUMERIC(12,2) NOT NULL,
  tipo_uso TEXT,
  chassi TEXT,
  renavam TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_evento TEXT UNIQUE NOT NULL,
  associado_id UUID REFERENCES associados(id),
  veiculo_id UUID REFERENCES veiculos(id),
  data_ocorrencia DATE,
  local_ocorrencia TEXT,
  tipo_ocorrencia TEXT,
  descricao TEXT,
  houve_terceiro BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'evento_aberto',
  responsavel_interno TEXT,
  oficina_atual TEXT DEFAULT 'Perfeitocar',
  data_abertura TIMESTAMP DEFAULT now(),
  data_encerramento TIMESTAMP
);

CREATE TABLE terceiros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cpf TEXT,
  telefone TEXT,
  placa_veiculo TEXT,
  modelo_veiculo TEXT,
  seguradora TEXT,
  documento_assinado BOOLEAN DEFAULT false,
  observacoes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE checklist_evento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE UNIQUE,
  comunicou_0800 BOOLEAN DEFAULT false,
  bo_realizado BOOLEAN DEFAULT false,
  documento_associado BOOLEAN DEFAULT false,
  cnh BOOLEAN DEFAULT false,
  documento_veiculo BOOLEAN DEFAULT false,
  fotos_ocorrencia BOOLEAN DEFAULT false,
  termo_associado_assinado BOOLEAN DEFAULT false,
  termo_terceiro_assinado BOOLEAN DEFAULT false,
  cota_paga BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE documentos_evento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  tipo_documento TEXT NOT NULL,
  nome_arquivo TEXT,
  url_arquivo TEXT,
  status TEXT DEFAULT 'anexado',
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE cotas_participacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE UNIQUE,
  valor_fipe NUMERIC(12,2) NOT NULL,
  percentual NUMERIC(5,2) NOT NULL,
  valor_cota NUMERIC(12,2) GENERATED ALWAYS AS ((valor_fipe * percentual) / 100) STORED,
  status_pagamento TEXT DEFAULT 'pendente',
  forma_pagamento TEXT,
  data_pagamento DATE,
  comprovante_url TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE oficinas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  cnpj TEXT,
  contato TEXT,
  whatsapp TEXT,
  endereco TEXT,
  status TEXT DEFAULT 'ativa',
  observacoes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE orcamentos_oficina (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  oficina_id UUID REFERENCES oficinas(id),
  data_orcamento DATE,
  valor_mao_obra NUMERIC(12,2),
  valor_total_estimado NUMERIC(12,2),
  prazo_estimado_dias INTEGER,
  arquivo_orcamento_url TEXT,
  observacoes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE pecas_evento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  orcamento_oficina_id UUID REFERENCES orcamentos_oficina(id) ON DELETE SET NULL,
  nome_peca TEXT NOT NULL,
  codigo_referencia TEXT,
  quantidade INTEGER DEFAULT 1,
  tipo_peca TEXT,
  prioridade TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'aguardando_cotacao',
  observacao_oficina TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE fornecedores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  cpf_cnpj TEXT,
  contato TEXT,
  whatsapp TEXT,
  cidade TEXT,
  tipos_pecas TEXT,
  status TEXT DEFAULT 'ativo',
  observacoes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE cotacoes_pecas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peca_evento_id UUID REFERENCES pecas_evento(id) ON DELETE CASCADE,
  fornecedor_id UUID REFERENCES fornecedores(id),
  tem_peca BOOLEAN DEFAULT true,
  valor_unitario NUMERIC(12,2),
  valor_frete NUMERIC(12,2) DEFAULT 0,
  valor_total NUMERIC(12,2) GENERATED ALWAYS AS (COALESCE(valor_unitario, 0) + COALESCE(valor_frete, 0)) STORED,
  prazo_entrega_dias INTEGER,
  condicao_peca TEXT,
  garantia TEXT,
  cotacao_escolhida BOOLEAN DEFAULT false,
  motivo_escolha TEXT,
  observacoes TEXT,
  data_cotacao DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE historico_evento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
  status_anterior TEXT,
  status_novo TEXT,
  descricao TEXT,
  usuario TEXT,
  created_at TIMESTAMP DEFAULT now()
);

INSERT INTO oficinas (nome, status)
VALUES ('Perfeitocar', 'ativa')
ON CONFLICT DO NOTHING;

CREATE VIEW melhores_cotacoes_por_peca AS
SELECT DISTINCT ON (p.id)
  p.id AS peca_evento_id,
  p.nome_peca,
  f.nome AS fornecedor,
  c.valor_unitario,
  c.valor_frete,
  c.valor_total,
  c.prazo_entrega_dias
FROM pecas_evento p
JOIN cotacoes_pecas c ON c.peca_evento_id = p.id
JOIN fornecedores f ON f.id = c.fornecedor_id
WHERE c.tem_peca = true
ORDER BY p.id, c.valor_total ASC, c.prazo_entrega_dias ASC NULLS LAST;
