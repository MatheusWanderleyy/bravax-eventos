# Bravax Protege - MVP de acompanhamento de eventos

Este MVP é um sistema web estático para acompanhar eventos, documentação, cota de participação, oficina, peças e cotações de fornecedores.

## Como abrir

Abra o arquivo `index.html` no navegador.

## O que já funciona

- Cadastro de novo evento.
- Cálculo automático da cota de participação:
  - Uber: 7% do valor FIPE.
  - Associado antigo: 6% do valor FIPE.
  - Associado novo: 5% do valor FIPE.
- Checklist obrigatório:
  - Comunicação ao 0800.200.1125.
  - BO.
  - Documentos.
  - Fotos.
  - Termo do associado.
  - Termo do terceiro quando houver terceiro.
  - Pagamento da cota.
- Oficina padrão: Perfeitocar.
- Cadastro de peças sinalizadas pela oficina.
- Cadastro de várias cotações por peça.
- Registro de fornecedor que não possui a peça.
- Comparação automática do menor valor disponível por peça.
- Cadastro simples de fornecedores.
- Persistência no navegador usando `localStorage`.
- OCR grátis via Tesseract.js para ler fotos de orçamento e sugerir peças/cotações sem API paga.
- IA online opcional para melhorar análise quando houver chave OpenAI ou Gemini configurada.
- Chat especialista com fallback para Ollama local quando não houver chave OpenAI/Gemini.

## Busca assistida na Hinova

Ao abrir "Novo Evento", o botão **🔍 Buscar na Hinova** procura, pela placa, um evento cadastrado na Hinova nos últimos 90 dias e preenche o formulário automaticamente (veículo, associado, telefone, FIPE, data, tipo quando confirmado como Uber). O atendente sempre confere e edita antes de salvar — a busca nunca grava nada sozinha, só sugere.

Para ativar em produção (Railway), configure as variáveis de ambiente:

```
HINOVA_SGA_TOKEN=...
HINOVA_USUARIO=...
HINOVA_SENHA=...
HINOVA_BASE_URL=https://api.hinova.com.br/api/sga/v2   (opcional, já é o padrão)
```

Sem essas variáveis, o botão continua visível mas mostra "Hinova indisponível" e o atendente preenche manualmente como sempre — não trava nada.

## Próximos passos técnicos

- Migrar dados para PostgreSQL ou Supabase.
- Adicionar login e perfis de usuário.
- Upload de documentos, fotos, BO e comprovantes.
- Histórico de mudança de status.
- Relatórios mensais.
- Exportação de cotação e autorização de compra.

## Chat especialista grátis com Ollama

O sistema tenta usar OpenAI/Gemini quando existe API key configurada. Se não houver chave, o chat especialista tenta usar Ollama local em `http://localhost:11434`.

Para ativar:

1. Instale o Ollama: https://ollama.com
2. No PowerShell, baixe um modelo leve:

```powershell
ollama pull llama3.2:3b
```

3. Inicie o serviço, se ele não iniciar automaticamente:

```powershell
ollama serve
```

4. Volte ao sistema e envie uma mensagem no chat especialista.

Se quiser outro modelo, abra `Configurar IA` e altere o campo `Modelo local Ollama`.
