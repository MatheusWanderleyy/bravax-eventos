# Especificacao funcional - Bravax Protege Eventos

## Objetivo

Controlar eventos abertos por associados desde a comunicacao inicial ate o reparo, mantendo rastreabilidade de documentos, cota de participacao, oficina, pecas e cotacoes de fornecedores.

## Regra operacional principal

O evento so deve avancar para oficina/reparo quando:

- O associado comunicou o 0800.200.1125.
- O BO da ocorrencia foi feito.
- Os documentos obrigatorios foram preenchidos/anexados.
- O terceiro assinou o documento, quando houver terceiro.
- A cota de participacao foi paga.

## Cota de participacao

- Uber: 7% do valor FIPE.
- Associado antigo: 6% do valor FIPE.
- Associado novo: 5% do valor FIPE.

## Status sugeridos

- Evento aberto.
- Aguardando comunicacao ao 0800.
- Aguardando BO.
- Aguardando documentos.
- Aguardando assinatura do terceiro.
- Aguardando pagamento da cota.
- Liberado para oficina.
- Na oficina.
- Aguardando orcamento da oficina.
- Cotando pecas.
- Aguardando aprovacao de compra.
- Pecas compradas.
- Em reparo.
- Servico concluido.
- Evento encerrado.

## MVP entregue nesta pasta

O MVP atual roda sem backend e salva os dados no navegador. Ele e ideal para validar fluxo interno, nomes dos campos e regras antes de contratar banco, login e hospedagem.

Fluxo de imagem recomendado no MVP:

1. Enviar foto do orcamento ou cotacao.
2. Rodar OCR gratis no navegador com Tesseract.js.
3. Conferir o texto extraido.
4. Gerar pecas ou valores a partir do texto.
5. Usar IA online apenas quando o OCR/local nao resolver.

Chat especialista:

- Com API key online, usa OpenAI ou Gemini.
- Sem API key online, tenta usar Ollama local em localhost:11434.
- Quando o usuario envia imagem no chat sem API online, o sistema roda OCR local e envia o texto extraido para o especialista local.
- O chat tenta usar o contexto dos eventos abertos. Se a pergunta mencionar placa, associado, CPF, numero do evento ou modelo, ele usa esse evento como referencia.
- Se nao houver mencao clara, usa o evento atualmente selecionado na tela.
- Se houver mais de um possivel evento, pede para o atendente informar placa, associado ou numero do evento.

Arquivos principais:

- `index.html`: estrutura da interface.
- `styles.css`: layout e identidade visual.
- `app.js`: regras de negocio, dados demo e persistencia local.
- `server.mjs`: servidor local simples em Node.
- `database.sql`: modelagem PostgreSQL para a proxima fase.

## Proxima fase recomendada

1. Adicionar autenticacao com perfis.
2. Criar backend com PostgreSQL/Supabase.
3. Substituir `localStorage` por API real.
4. Adicionar upload de BO, fotos e comprovantes.
5. Criar historico auditavel por usuario.
6. Gerar autorizacao de compra por peca.
7. Exportar relatorios por periodo, oficina e fornecedor.
