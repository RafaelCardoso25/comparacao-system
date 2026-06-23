import React, { useState, useRef } from 'react';

const MAX_FILES = 10;

export default function UploadPhase({ onExtracted }) {
  const [files, setFiles] = useState([]);
  const [supplierNames, setSupplierNames] = useState({});
  const [columnHints, setColumnHints] = useState({});
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, name: '' });
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  function addFiles(newFiles) {
    setError('');
    const pdfs = newFiles.filter(f => f.type === 'application/pdf');
    if (pdfs.length !== newFiles.length) setError('Apenas arquivos PDF são aceitos.');
    setFiles(prev => {
      const combined = [...prev, ...pdfs];
      if (combined.length > MAX_FILES) {
        setError(`Máximo de ${MAX_FILES} cotações permitidas.`);
        return combined.slice(0, MAX_FILES);
      }
      return combined;
    });
  }

  function removeFile(index) {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setSupplierNames(prev => {
      const next = { ...prev };
      delete next[index];
      const reindexed = {};
      Object.entries(next).forEach(([k, v]) => {
        const ki = parseInt(k);
        if (ki > index) reindexed[ki - 1] = v;
        else reindexed[ki] = v;
      });
      return reindexed;
    });
    setColumnHints(prev => {
      const next = { ...prev };
      delete next[index];
      const reindexed = {};
      Object.entries(next).forEach(([k, v]) => {
        const ki = parseInt(k);
        if (ki > index) reindexed[ki - 1] = v;
        else reindexed[ki] = v;
      });
      return reindexed;
    });
  }

  function handleSupplierName(index, value) {
    setSupplierNames(prev => ({ ...prev, [index]: value }));
  }

  function handleColumnHint(index, field, value) {
    setColumnHints(prev => ({
      ...prev,
      [index]: { ...prev[index], [field]: value }
    }));
  }

  async function handleExtract() {
    if (files.length < 2) {
      setError('Envie pelo menos 2 arquivos PDF.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      files.forEach((f, i) => {
        formData.append('pdfs', f);
        const name = supplierNames[i]?.trim() || `Cotação ${i + 1}`;
        formData.append(`supplierName_${i}`, name);

        const colProduto    = columnHints[i]?.produto?.trim()    || '';
        const colQuantidade = columnHints[i]?.quantidade?.trim() || '';
        const colPreco      = columnHints[i]?.preco?.trim()      || '';
        formData.append(`colProduto_${i}`,    colProduto);
        formData.append(`colQuantidade_${i}`, colQuantidade);
        formData.append(`colPreco_${i}`,      colPreco);
      });

      setProgress({ current: 0, total: files.length, name: files[0]?.name });

      const progressInterval = setInterval(() => {
        setProgress(prev => {
          if (prev.current < prev.total - 1) {
            const next = prev.current + 1;
            return { ...prev, current: next, name: files[next]?.name || '' };
          }
          return prev;
        });
      }, 4000);

      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/extract-pdfs`, {
        method: 'POST',
        body: formData
      });

      clearInterval(progressInterval);
      setProgress({ current: files.length, total: files.length, name: '' });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Erro ao processar os PDFs.');

      const errors = data.data.filter(d => d.error);
      if (errors.length > 0) {
        setError(`Aviso: ${errors.map(e => `${e.originalName}: ${e.error}`).join(' | ')}`);
      }

      const cotacoesData = data.data.map((d, i) => ({
        cotacaoName: supplierNames[i]?.trim() || d.cotacaoName,
        originalName: d.originalName
      }));

      onExtracted(data.data, cotacoesData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0, name: '' });
    }
  }

  const progressPercent = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="upload-phase">
      <div className="phase-header">
        <span className="phase-tag">ETAPA 1</span>
        <h2>Upload das Cotações</h2>
        <p>
          Envie de 2 a {MAX_FILES} arquivos PDF. Digite o nome do fornecedor e,
          opcionalmente, o nome das colunas de produto, quantidade e preço para melhorar a leitura.
        </p>
      </div>

      {/* Dropzone */}
      <div
        className={`dropzone ${dragging ? 'dragging' : ''} ${files.length > 0 ? 'has-files' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
        onClick={() => files.length < MAX_FILES && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          onChange={e => addFiles(Array.from(e.target.files))}
          style={{ display: 'none' }}
        />
        <div className="dropzone-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        </div>
        <p className="dropzone-text">
          {files.length >= MAX_FILES
            ? `Limite de ${MAX_FILES} cotações atingido`
            : 'Arraste os PDFs aqui ou clique para selecionar'}
        </p>
        <p className="dropzone-subtext">
          {files.length}/{MAX_FILES} arquivos · PDFs normais e escaneados aceitos
        </p>
      </div>

      {/* Lista de arquivos */}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((file, i) => (
            <li key={i} className="file-item file-item--with-input">
              <div className="file-item-top">
                <span className="file-badge">#{i + 1}</span>
                <span className="file-name">{file.name}</span>
                <span className="file-size">{(file.size / 1024).toFixed(0)} KB</span>
                <button className="file-remove" onClick={() => removeFile(i)} title="Remover">✕</button>
              </div>

              {/* Nome do fornecedor */}
              <input
                className="supplier-name-input"
                type="text"
                placeholder="Nome do fornecedor (ex: Distribuidora Silva)"
                value={supplierNames[i] || ''}
                onChange={e => handleSupplierName(i, e.target.value)}
                maxLength={50}
              />

              {/* Dicas de coluna */}
              <div className="column-hints">
                <div className="column-hint-label">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Opcional — nome exato das colunas no PDF para leitura mais precisa
                </div>
                <div className="column-hint-inputs">
                  <input
                    className="column-hint-input"
                    type="text"
                    placeholder="Coluna de produto (ex: Descrição)"
                    value={columnHints[i]?.produto || ''}
                    onChange={e => handleColumnHint(i, 'produto', e.target.value)}
                    maxLength={60}
                  />
                  <input
                    className="column-hint-input"
                    type="text"
                    placeholder="Coluna de quantidade (ex: Qtd)"
                    value={columnHints[i]?.quantidade || ''}
                    onChange={e => handleColumnHint(i, 'quantidade', e.target.value)}
                    maxLength={60}
                  />
                  <input
                    className="column-hint-input"
                    type="text"
                    placeholder="Coluna de preço total (ex: Total)"
                    value={columnHints[i]?.preco || ''}
                    onChange={e => handleColumnHint(i, 'preco', e.target.value)}
                    maxLength={60}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Barra de progresso */}
      {loading && progress.total > 0 && (
        <div className="progress-wrapper">
          <div className="progress-header">
            <span className="progress-label">
              Processando {progress.current + 1} de {progress.total}
              {progress.name && <span className="progress-filename"> — {progress.name}</span>}
            </span>
            <span className="progress-percent">{progressPercent}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <p className="progress-hint">
            Lendo as colunas de cada cotação. PDFs escaneados podem levar um pouco mais.
          </p>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      <button
        className="btn btn-primary btn-large"
        onClick={handleExtract}
        disabled={loading || files.length < 2}
      >
        {loading ? (
          <><span className="spinner" /> Extraindo dados...</>
        ) : (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
            Extrair Dados
          </>
        )}
      </button>
    </div>
  );
}