import React, { useState, useMemo, useRef, useEffect } from 'react';
import { UploadCloud, File as FileIcon, Loader2, Download, Layers, Users, X, CheckCircle2, FileText, Eye, UserPen, Save, FolderOpen, AlertTriangle, ArrowLeftRight, Wand2, Package } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { ExtractedSignaturePage, GroupingMode, ProcessedDocument, SavedConfiguration, AppMode, ExecutedUpload, ExecutedSignaturePage, AssemblyMatch } from './types';
import { getPageCount, renderPageToImage, generateGroupedPdfs, findSignaturePageCandidates, extractSinglePagePdf, assembleAllDocuments } from './services/pdfService';
import { analyzePage, analyzeExecutedPage } from './services/geminiService';
import { autoMatch, createManualMatch } from './services/matchingService';
import SignatureCard from './components/SignatureCard';
import PdfPreviewModal from './components/PdfPreviewModal';
import InstructionsModal from './components/InstructionsModal';
import CompletionChecklist from './components/CompletionChecklist';
import ExecutedPageCard from './components/ExecutedPageCard';
import MatchPickerModal from './components/MatchPickerModal';

// Concurrency Constants for AI - Keeping AI limit per doc to avoid rate limits, but unlimited docs
const CONCURRENT_AI_REQUESTS_PER_DOC = 5;

const App: React.FC = () => {
  const [documents, setDocuments] = useState<ProcessedDocument[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string>('');
  
  // Grouping & Filtering State
  const [groupingMode, setGroupingMode] = useState<GroupingMode>('agreement');
  
  // App Mode State
  const [appMode, setAppMode] = useState<AppMode>('extract');

  // Assembly State
  const [executedUploads, setExecutedUploads] = useState<ExecutedUpload[]>([]);
  const [assemblyMatches, setAssemblyMatches] = useState<AssemblyMatch[]>([]);
  const [isDraggingExecuted, setIsDraggingExecuted] = useState(false);

  // Match Picker Modal State
  const [matchPickerState, setMatchPickerState] = useState<{
    isOpen: boolean;
    blankPageId: string | null;
    currentMatch: AssemblyMatch | null;
  }>({ isOpen: false, blankPageId: null, currentMatch: null });

  // Drag & Drop State
  const [isDragging, setIsDragging] = useState(false);

  // Preview State
  const [previewState, setPreviewState] = useState<{
    isOpen: boolean;
    url: string | null;
    title: string;
  }>({ isOpen: false, url: null, title: '' });

  // Instructions Modal State
  const [isInstructionsOpen, setIsInstructionsOpen] = useState(false);

  // Ref for load-config hidden file input
  const loadConfigInputRef = useRef<HTMLInputElement>(null);

  // Route newly-pending documents: restored ones → rescan+merge, new ones → normal extract button
  // Using a ref to prevent double-firing in StrictMode
  const pendingRescanIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const restoredPending = documents.filter(
      d => d.status === 'pending' && d.wasRestored && d.file && !pendingRescanIds.current.has(d.id)
    );
    if (restoredPending.length === 0) return;

    restoredPending.forEach(d => pendingRescanIds.current.add(d.id));
    processRestoredDocuments(restoredPending);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents]);

  // --- Handlers ---

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const uploadedFiles = Array.from(files);

    // Compute next state outside the setter so it only runs once (avoids StrictMode double-invoke)
    setDocuments(prev => {
      const updatedDocs = [...prev];
      const newDocs: ProcessedDocument[] = [];

      for (const f of uploadedFiles) {
        const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

        // Check if this file matches a restored document by name
        const restoredIdx = updatedDocs.findIndex(d => d.status === 'restored' && d.name === f.name);

        if (restoredIdx !== -1) {
          // Attach the file; snapshot savedPages now before we clear them; rescan triggered via useEffect
          updatedDocs[restoredIdx] = {
            ...updatedDocs[restoredIdx],
            file: f,
            status: 'pending',
            wasRestored: true,
            savedPages: updatedDocs[restoredIdx].extractedPages,
          };
        } else {
          // Brand new file
          newDocs.push({
            id: uuidv4(),
            name: f.name,
            file: f,
            pageCount: 0,
            status: isPdf ? 'pending' : 'error',
            extractedPages: [],
          });
        }
      }

      return [...updatedDocs, ...newDocs];
    });
  };

  const handleProcessPending = () => {
    // Only process truly new pending docs — restored ones auto-rescan via useEffect
    const pendingDocs = documents.filter(d => d.status === 'pending' && d.file !== null && !d.wasRestored);
    processAllDocuments(pendingDocs);
  };

  /**
   * Process all documents in parallel ("All in one go")
   */
  const processAllDocuments = async (docsToProcess: ProcessedDocument[]) => {
    if (docsToProcess.length === 0) return;

    setIsProcessing(true);
    setCurrentStatus(`Processing ${docsToProcess.length} documents...`);

    // Fire off all requests simultaneously
    await Promise.all(docsToProcess.map(doc => processSingleDocument(doc)));

    setIsProcessing(false);
    setCurrentStatus('');
  };

  /**
   * Re-scan restored documents and merge fresh extraction with saved user edits.
   * Saved edits (partyName, signatoryName, capacity, copies) are preserved for
   * pages that still appear in the re-scan (matched by pageIndex).
   */
  const processRestoredDocuments = async (restoredDocs: ProcessedDocument[]) => {
    if (restoredDocs.length === 0) return;

    if (!process.env.API_KEY) {
      alert("API_KEY is missing from environment. Cannot re-scan documents.");
      return;
    }

    setIsProcessing(true);
    setCurrentStatus(`Re-scanning ${restoredDocs.length} restored document${restoredDocs.length > 1 ? 's' : ''}...`);

    await Promise.all(restoredDocs.map(doc => processSingleDocumentWithMerge(doc)));

    setIsProcessing(false);
    setCurrentStatus('');
  };

  /**
   * Like processSingleDocument but merges result with previously-saved page edits.
   */
  const processSingleDocumentWithMerge = async (doc: ProcessedDocument) => {
    // savedPages was snapshotted onto the doc object at upload time, before we clear extractedPages
    const savedPages: ExtractedSignaturePage[] = doc.savedPages ?? doc.extractedPages;

    setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'processing', progress: 0, extractedPages: [], savedPages: undefined } : d));

    try {
      const file = doc.file!;
      const pageCount = await getPageCount(file);

      const candidateIndices = await findSignaturePageCandidates(file, (curr, total) => {
        const progress = Math.round((curr / total) * 30);
        setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress } : d));
      });

      const freshPages: ExtractedSignaturePage[] = [];

      if (candidateIndices.length > 0) {
        let processedCount = 0;
        const totalCandidates = candidateIndices.length;

        for (let i = 0; i < candidateIndices.length; i += CONCURRENT_AI_REQUESTS_PER_DOC) {
          const chunk = candidateIndices.slice(i, i + CONCURRENT_AI_REQUESTS_PER_DOC);

          const chunkPromises = chunk.map(async (pageIndex) => {
            try {
              const { dataUrl, width, height } = await renderPageToImage(file, pageIndex);
              const analysis = await analyzePage(dataUrl);

              if (analysis.isSignaturePage) {
                return analysis.signatures.map(sig => {
                  // Find a saved page at the same pageIndex to merge edits from
                  const saved = savedPages.find(sp => sp.pageIndex === pageIndex);
                  return {
                    id: saved?.id ?? uuidv4(),
                    documentId: doc.id,
                    documentName: doc.name,
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    // Prefer saved user edits; fall back to fresh AI extraction
                    partyName: saved?.partyName ?? sig.partyName ?? 'Unknown Party',
                    signatoryName: saved?.signatoryName ?? sig.signatoryName ?? '',
                    capacity: saved?.capacity ?? sig.capacity ?? 'Signatory',
                    copies: saved?.copies ?? 1,
                    // Always use the freshly rendered thumbnail
                    thumbnailUrl: dataUrl,
                    originalWidth: width,
                    originalHeight: height,
                  };
                });
              }
            } catch (err) {
              console.error(`Error re-scanning page ${pageIndex} of ${doc.name}`, err);
            }
            return [];
          });

          const chunkResults = await Promise.all(chunkPromises);

          processedCount += chunk.length;
          const aiProgress = 30 + Math.round((processedCount / totalCandidates) * 70);
          setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: aiProgress } : d));

          chunkResults.flat().forEach(p => { if (p) freshPages.push(p); });
        }
      }

      setDocuments(prev => prev.map(d => d.id === doc.id ? {
        ...d,
        status: 'completed',
        progress: 100,
        pageCount,
        extractedPages: freshPages,
        wasRestored: undefined,
        savedPages: undefined,
      } : d));

      pendingRescanIds.current.delete(doc.id);
      setCurrentStatus(`Re-scanned '${doc.name}' — edits preserved`);
      setTimeout(() => setCurrentStatus(''), 3000);

    } catch (error) {
      console.error(`Error re-scanning ${doc.name}`, error);
      pendingRescanIds.current.delete(doc.id);
      setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'error', wasRestored: undefined, savedPages: undefined } : d));
    }
  };

  const processSingleDocument = async (doc: ProcessedDocument) => {
      if (!doc.file) return; // Safety guard — should not happen for normal pending docs

      // Update status to processing
      setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'processing', progress: 0 } : d));

      try {
        const pageCount = await getPageCount(doc.file);
        
        // 1. Full Document Text Scan (Heuristic) - Optimized in pdfService
        const candidateIndices = await findSignaturePageCandidates(doc.file, (curr, total) => {
           // Update progress for scanning phase (0-30%)
           const progress = Math.round((curr / total) * 30);
           setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress } : d));
        });

        // 2. Visual AI Analysis on Candidate Pages (Parallelized)
        const extractedPages: ExtractedSignaturePage[] = [];

        if (candidateIndices.length === 0) {
           console.log(`No signature candidates found in ${doc.name} via regex.`);
           setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: 100 } : d));
        } else {
            // Process candidates in chunks to respect AI concurrency limit PER DOC
            let processedCount = 0;
            const totalCandidates = candidateIndices.length;

            for (let i = 0; i < candidateIndices.length; i += CONCURRENT_AI_REQUESTS_PER_DOC) {
                const chunk = candidateIndices.slice(i, i + CONCURRENT_AI_REQUESTS_PER_DOC);
                
                const chunkPromises = chunk.map(async (pageIndex) => {
                    try {
                        const { dataUrl, width, height } = await renderPageToImage(doc.file, pageIndex);
                        const analysis = await analyzePage(dataUrl);

                        if (analysis.isSignaturePage) {
                            return analysis.signatures.map(sig => ({
                                id: uuidv4(),
                                documentId: doc.id,
                                documentName: doc.name,
                                pageIndex: pageIndex,
                                pageNumber: pageIndex + 1,
                                partyName: sig.partyName || "Unknown Party",
                                signatoryName: sig.signatoryName || "",
                                capacity: sig.capacity || "Signatory",
                                copies: 1,
                                thumbnailUrl: dataUrl,
                                originalWidth: width,
                                originalHeight: height
                            }));
                        }
                    } catch (err) {
                        console.error(`Error analyzing page ${pageIndex} of ${doc.name}`, err);
                    }
                    return [];
                });

                const chunkResults = await Promise.all(chunkPromises);
                
                // Update progress for AI phase (30-100%)
                processedCount += chunk.length;
                const aiProgress = 30 + Math.round((processedCount / totalCandidates) * 70);
                setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, progress: aiProgress } : d));

                // Flatten and add to results
                chunkResults.flat().forEach(p => {
                    if(p) extractedPages.push(p);
                });
            }
        }

        setDocuments(prev => prev.map(d => d.id === doc.id ? { 
          ...d, 
          status: 'completed', 
          progress: 100,
          pageCount,
          extractedPages 
        } : d));

      } catch (error) {
        console.error(`Error processing doc ${doc.name}`, error);
        setDocuments(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'error' } : d));
      }
  };

  const handleUpdateCopies = (pageId: string, newCount: number) => {
    setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, copies: newCount } : p)
    })));
  };

  const handleUpdateParty = (pageId: string, newParty: string) => {
     setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, partyName: newParty } : p)
    })));
  };

  const handleUpdateSignatory = (pageId: string, newSignatory: string) => {
    setDocuments(prev => prev.map(doc => ({
     ...doc,
     extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, signatoryName: newSignatory } : p)
   })));
 };

  const handleUpdateCapacity = (pageId: string, newCapacity: string) => {
     setDocuments(prev => prev.map(doc => ({
      ...doc,
      extractedPages: doc.extractedPages.map(p => p.id === pageId ? { ...p, capacity: newCapacity } : p)
    })));
  };

  const handleDeletePage = (pageId: string) => {
      setDocuments(prev => prev.map(doc => ({
        ...doc,
        extractedPages: doc.extractedPages.filter(p => p.id !== pageId)
      })));
  };

  const removeDocument = (docId: string) => {
    setDocuments(prev => prev.filter(d => d.id !== docId));
  };

  // --- Save / Load Configuration ---

  const handleSaveConfiguration = () => {
    const pages = documents.flatMap(d => d.extractedPages);
    if (pages.length === 0) return;

    const config: SavedConfiguration = {
      version: 1,
      savedAt: new Date().toISOString(),
      groupingMode,
      documents: documents.map(({ id, name, pageCount }) => ({ id, name, pageCount })),
      extractedPages: pages,
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SignatureConfig_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleLoadConfiguration = (file: File | null) => {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const raw = e.target?.result as string;
        const config = JSON.parse(raw) as SavedConfiguration;

        // Basic validation
        if (config.version !== 1 || !Array.isArray(config.documents) || !Array.isArray(config.extractedPages)) {
          alert('Invalid configuration file.');
          return;
        }

        // Build restored documents, distributing extractedPages back by documentId
        const pagesByDocId = new Map<string, ExtractedSignaturePage[]>();
        for (const page of config.extractedPages) {
          const arr = pagesByDocId.get(page.documentId) ?? [];
          arr.push(page);
          pagesByDocId.set(page.documentId, arr);
        }

        const restoredDocs: ProcessedDocument[] = config.documents.map(d => ({
          id: d.id,
          name: d.name,
          file: null,
          pageCount: d.pageCount,
          status: 'restored',
          extractedPages: pagesByDocId.get(d.id) ?? [],
        }));

        setDocuments(restoredDocs);
        setGroupingMode(config.groupingMode);
        setCurrentStatus('Configuration loaded — re-upload PDFs to enable pack download');
        setTimeout(() => setCurrentStatus(''), 4000);
      } catch {
        alert('Could not read configuration file. Make sure it is a valid Signature Packet IDE JSON.');
      }
    };
    reader.readAsText(file);

    // Reset so the same file can be re-loaded later
    if (loadConfigInputRef.current) loadConfigInputRef.current.value = '';
  };

  // --- Assembly Mode Handlers ---

  const allExecutedPages = useMemo(() => {
    return executedUploads.flatMap(u => u.executedPages);
  }, [executedUploads]);

  const handleExecutedFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const uploadedFiles = Array.from(files);

    // Create ExecutedUpload entries
    const newUploads: ExecutedUpload[] = uploadedFiles
      .filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
      .map(f => ({
        id: uuidv4(),
        file: f,
        fileName: f.name,
        pageCount: 0,
        status: 'pending' as const,
        executedPages: [],
      }));

    // Check for duplicate filenames
    const existingNames = new Set(executedUploads.map(u => `${u.fileName}_${u.file.size}`));
    const deduped = newUploads.filter(u => {
      const key = `${u.fileName}_${u.file.size}`;
      if (existingNames.has(key)) {
        console.warn(`Skipping duplicate executed upload: ${u.fileName}`);
        return false;
      }
      return true;
    });

    if (deduped.length === 0) return;

    setExecutedUploads(prev => [...prev, ...deduped]);

    // Process each upload
    for (const upload of deduped) {
      await processExecutedUpload(upload);
    }
  };

  const processExecutedUpload = async (upload: ExecutedUpload) => {
    setExecutedUploads(prev => prev.map(u => u.id === upload.id ? { ...u, status: 'processing', progress: 0 } : u));

    try {
      const pageCount = await getPageCount(upload.file);
      const executedPages: ExecutedSignaturePage[] = [];

      for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
        try {
          const { dataUrl, width, height } = await renderPageToImage(upload.file, pageIndex);
          const analysis = await analyzeExecutedPage(dataUrl);

          if (analysis.signatures.length > 0) {
            // Create an ExecutedSignaturePage for each signature block found
            for (const sig of analysis.signatures) {
              executedPages.push({
                id: uuidv4(),
                sourceUploadId: upload.id,
                sourceFileName: upload.fileName,
                pageIndexInSource: pageIndex,
                pageNumber: pageIndex + 1,
                extractedDocumentName: analysis.documentName || '',
                extractedPartyName: sig.partyName || '',
                extractedSignatoryName: sig.signatoryName || '',
                extractedCapacity: sig.capacity || '',
                isConfirmedExecuted: analysis.isExecuted,
                thumbnailUrl: dataUrl,
                originalWidth: width,
                originalHeight: height,
                matchedBlankPageId: null,
                matchConfidence: null,
              });
            }
          } else {
            // No signatures found, but still create an entry for the page
            executedPages.push({
              id: uuidv4(),
              sourceUploadId: upload.id,
              sourceFileName: upload.fileName,
              pageIndexInSource: pageIndex,
              pageNumber: pageIndex + 1,
              extractedDocumentName: analysis.documentName || '',
              extractedPartyName: '',
              extractedSignatoryName: '',
              extractedCapacity: '',
              isConfirmedExecuted: analysis.isExecuted,
              thumbnailUrl: dataUrl,
              originalWidth: width,
              originalHeight: height,
              matchedBlankPageId: null,
              matchConfidence: null,
            });
          }
        } catch (err) {
          console.error(`Error processing executed page ${pageIndex} of ${upload.fileName}`, err);
        }

        // Update progress
        const progress = Math.round(((pageIndex + 1) / pageCount) * 100);
        setExecutedUploads(prev => prev.map(u => u.id === upload.id ? { ...u, progress } : u));
      }

      setExecutedUploads(prev => prev.map(u => u.id === upload.id ? {
        ...u,
        status: 'completed',
        progress: 100,
        pageCount,
        executedPages,
      } : u));

    } catch (error) {
      console.error(`Error processing executed upload ${upload.fileName}`, error);
      setExecutedUploads(prev => prev.map(u => u.id === upload.id ? { ...u, status: 'error' } : u));
    }
  };

  const handleAutoMatch = () => {
    const newMatches = autoMatch(allPages, allExecutedPages, assemblyMatches);
    if (newMatches.length === 0) {
      setCurrentStatus('No new matches found');
      setTimeout(() => setCurrentStatus(''), 2000);
      return;
    }

    // Merge: keep existing confirmed/overridden matches, replace auto-matches, add new ones
    setAssemblyMatches(prev => {
      const preserved = prev.filter(m => m.status === 'user-confirmed' || m.status === 'user-overridden');
      return [...preserved, ...newMatches];
    });

    setCurrentStatus(`Auto-matched ${newMatches.length} page${newMatches.length > 1 ? 's' : ''}`);
    setTimeout(() => setCurrentStatus(''), 3000);
  };

  const handleManualMatch = (blankPageId: string, executedPageId: string) => {
    const blank = allPages.find(p => p.id === blankPageId);
    const executed = allExecutedPages.find(p => p.id === executedPageId);
    if (!blank || !executed) return;

    const match = createManualMatch(blank, executed);

    setAssemblyMatches(prev => {
      // Remove any existing match for this blank page
      const filtered = prev.filter(m => m.blankPageId !== blankPageId);
      return [...filtered, match];
    });
  };

  const handleUnmatch = (blankPageId: string) => {
    setAssemblyMatches(prev => prev.filter(m => m.blankPageId !== blankPageId));
  };

  const handleUnmatchByExecutedId = (executedPageId: string) => {
    setAssemblyMatches(prev => prev.filter(m => m.executedPageId !== executedPageId));
  };

  const handleChecklistCellClick = (blankPageId: string, currentMatch: AssemblyMatch | null) => {
    setMatchPickerState({
      isOpen: true,
      blankPageId,
      currentMatch,
    });
  };

  const handleAssembleDocuments = async () => {
    if (assemblyMatches.length === 0) return;

    // Warn about unmatched pages
    const unmatchedCount = allPages.length - assemblyMatches.length;
    if (unmatchedCount > 0) {
      const proceed = window.confirm(
        `${unmatchedCount} signature page${unmatchedCount > 1 ? 's' : ''} still unmatched. ` +
        `Unmatched pages will keep the original (blank) signature page in the assembled document. Continue?`
      );
      if (!proceed) return;
    }

    setIsProcessing(true);
    setCurrentStatus('Assembling documents...');

    try {
      const assembledPdfs = await assembleAllDocuments(documents, assemblyMatches, executedUploads);

      const zip = new JSZip();
      for (const [filename, data] of Object.entries(assembledPdfs)) {
        zip.file(filename, data);
      }

      const zipContent = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Assembled_Documents_${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

    } catch (e) {
      console.error('Assembly error:', e);
      alert('Failed to assemble documents');
    } finally {
      setIsProcessing(false);
      setCurrentStatus('');
    }
  };

  const removeExecutedUpload = (uploadId: string) => {
    // Also remove any matches that reference pages from this upload
    setExecutedUploads(prev => {
      const upload = prev.find(u => u.id === uploadId);
      if (upload) {
        const pageIds = new Set(upload.executedPages.map(p => p.id));
        setAssemblyMatches(matches => matches.filter(m => !pageIds.has(m.executedPageId)));
      }
      return prev.filter(u => u.id !== uploadId);
    });
  };

  // --- Preview Logic ---

  const openPreview = (url: string, title: string) => {
    setPreviewState({ isOpen: true, url, title });
  };

  const closePreview = () => {
    if (previewState.url) {
      URL.revokeObjectURL(previewState.url);
    }
    setPreviewState({ isOpen: false, url: null, title: '' });
  };

  const handlePreviewDocument = async (doc: ProcessedDocument) => {
    if (doc.status === 'error' || doc.status === 'restored' || !doc.file) return;
    const url = URL.createObjectURL(doc.file);
    openPreview(url, doc.name);
  };

  const handlePreviewSignaturePage = async (page: ExtractedSignaturePage) => {
    // Find the original document file
    const parentDoc = documents.find(d => d.id === page.documentId);
    if (!parentDoc || !parentDoc.file) return;

    try {
      const pdfBytes = await extractSinglePagePdf(parentDoc.file, page.pageIndex);
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      openPreview(url, `${page.documentName} - Page ${page.pageNumber}`);
    } catch (e) {
      console.error("Preview error", e);
      alert("Could not generate preview.");
    }
  };

  // --- Derived State for View ---

  const allPages = useMemo(() => {
    return documents.flatMap(d => d.extractedPages);
  }, [documents]);

  const uniqueParties = useMemo(() => {
    const parties = new Set(allPages.map(p => p.partyName));
    return ['All', ...(Array.from(parties) as string[]).sort()];
  }, [allPages]);

  const displayedPages = useMemo(() => {
    let pages = allPages;
    
    // Sort logic
    if (groupingMode === 'agreement') {
      return pages.sort((a, b) => {
        if (a.documentName !== b.documentName) return a.documentName.localeCompare(b.documentName);
        return a.pageIndex - b.pageIndex;
      });
    } else if (groupingMode === 'counterparty') {
      return pages.sort((a, b) => {
        if (a.partyName !== b.partyName) return a.partyName.localeCompare(b.partyName);
        return a.documentName.localeCompare(b.documentName);
      });
    } else {
       // By Signatory
       return pages.sort((a, b) => {
         const sigA = a.signatoryName || 'ZZZ';
         const sigB = b.signatoryName || 'ZZZ';
         if (sigA !== sigB) return sigA.localeCompare(sigB);
         return a.partyName.localeCompare(b.partyName);
       });
    }
  }, [allPages, groupingMode]);

  const navigationGroups = useMemo(() => {
    const groups = new Set<string>();
    displayedPages.forEach(p => {
      if (groupingMode === 'agreement') groups.add(p.documentName);
      else if (groupingMode === 'counterparty') groups.add(p.partyName);
      else groups.add(p.signatoryName || 'Unknown Signatory');
    });
    return Array.from(groups);
  }, [displayedPages, groupingMode]);

  const scrollToGroup = (groupName: string) => {
    const id = `group-${groupName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // --- Export Logic ---

  const handleDownloadPack = async () => {
    if (displayedPages.length === 0) return;
    setIsProcessing(true);
    setCurrentStatus('Generating ZIP Pack...');
    
    try {
      const pdfs = await generateGroupedPdfs(documents, displayedPages, groupingMode);
      
      const zip = new JSZip();
      
      // Add each PDF to the zip file
      for (const [filename, data] of Object.entries(pdfs)) {
        zip.file(filename, data);
      }

      // Generate the ZIP blob
      const zipContent = await zip.generateAsync({ type: 'blob' });
      
      // Trigger download
      const url = window.URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      link.download = `SignaturePack_${groupingMode}_${new Date().toISOString().slice(0,10)}.zip`;
      link.click();
      
    } catch (e) {
      console.error(e);
      alert("Failed to generate ZIP pack");
    } finally {
      setIsProcessing(false);
      setCurrentStatus('');
    }
  };

  // --- Render ---

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      
      {/* PDF Preview Modal */}
      <PdfPreviewModal 
        isOpen={previewState.isOpen}
        title={previewState.title}
        onClose={closePreview}
        pdfUrl={previewState.url}
      />

      {/* Instructions Modal */}
      <InstructionsModal
        isOpen={isInstructionsOpen}
        onClose={() => setIsInstructionsOpen(false)}
        pages={displayedPages}
      />

      {/* Match Picker Modal */}
      <MatchPickerModal
        isOpen={matchPickerState.isOpen}
        onClose={() => setMatchPickerState({ isOpen: false, blankPageId: null, currentMatch: null })}
        blankPage={allPages.find(p => p.id === matchPickerState.blankPageId) || null}
        currentMatch={matchPickerState.currentMatch}
        executedPages={allExecutedPages}
        allMatches={assemblyMatches}
        onConfirmMatch={handleManualMatch}
        onUnmatch={handleUnmatch}
      />

      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between flex-shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-lg">S</div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight leading-none">Signature Packet IDE</h1>
            <p className="text-xs text-slate-500 font-medium">Automated Signature Page Extraction</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
             {/* Stats */}
             <div className="hidden md:flex gap-4 text-xs font-medium text-slate-500 mr-4">
               <span>{documents.length} Docs</span>
               <span>{allPages.length} Sig Pages Found</span>
             </div>
             {/* Save / Load Config */}
             <div className="flex items-center gap-2">
               <input
                 ref={loadConfigInputRef}
                 type="file"
                 accept=".json"
                 className="hidden"
                 id="loadConfigInput"
                 onChange={(e) => handleLoadConfiguration(e.target.files?.[0] ?? null)}
               />
               <button
                 onClick={() => loadConfigInputRef.current?.click()}
                 className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
                 title="Load a previously saved configuration"
               >
                 <FolderOpen size={13} /> Load Config
               </button>
               <button
                 onClick={handleSaveConfiguration}
                 disabled={allPages.length === 0}
                 className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed rounded-md transition-colors"
                 title="Save current configuration as JSON"
               >
                 <Save size={13} /> Save Config
               </button>
             </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar: Documents */}
        <div className="w-80 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
          <div className="p-4 border-b border-slate-100">
             <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Documents</h2>
             <div 
                className={`border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center text-center transition-colors cursor-pointer ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-400 hover:bg-slate-50'}`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  handleFileUpload(e.dataTransfer.files);
                }}
             >
                <input 
                  type="file" 
                  multiple 
                  accept=".pdf"
                  className="hidden" 
                  id="fileInput"
                  onChange={(e) => handleFileUpload(e.target.files)}
                />
                <label htmlFor="fileInput" className="cursor-pointer flex flex-col items-center">
                   <UploadCloud className="text-blue-500 mb-2" size={24} />
                   <span className="text-sm font-medium text-slate-700">Upload Agreements</span>
                   <span className="text-xs text-slate-400 mt-1">PDF only</span>
                </label>
             </div>

             <button
                onClick={handleProcessPending}
                disabled={isProcessing || !documents.some(d => d.status === 'pending')}
                className="w-full mt-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2"
             >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
                Extract
             </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2">
             {documents.map(doc => (
               <div key={doc.id} className={`group relative flex items-center gap-3 p-3 rounded-md border transition-all ${
                 doc.status === 'error' ? 'bg-red-50 border-red-100' :
                 doc.status === 'restored' ? 'bg-amber-50 border-amber-100' :
                 'hover:bg-slate-50 border-transparent hover:border-slate-100'
               }`}>
                  <div className={`p-2 rounded text-slate-500 ${
                    doc.status === 'error' ? 'bg-red-100 text-red-500' :
                    doc.status === 'restored' ? 'bg-amber-100 text-amber-600' :
                    'bg-slate-100'
                  }`}>
                     <FileIcon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                     <p className={`text-sm font-medium truncate ${
                       doc.status === 'error' ? 'text-red-700' :
                       doc.status === 'restored' ? 'text-amber-800' :
                       'text-slate-700'
                     }`} title={doc.name}>{doc.name}</p>
                     <div className="text-xs text-slate-500 flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          {doc.status === 'processing' && <><Loader2 size={10} className="animate-spin" /> Processing...</>}
                          {doc.status === 'completed' && <><CheckCircle2 size={10} className="text-green-500" /> {doc.extractedPages.length} sig pages</>}
                          {doc.status === 'error' && <span className="text-red-500">PDF only</span>}
                          {doc.status === 'pending' && 'Queued'}
                          {doc.status === 'restored' && (
                            <span className="flex items-center gap-1 text-amber-600" title="Re-upload this PDF to enable pack download and re-scan for changes">
                              <AlertTriangle size={10} /> Needs file
                            </span>
                          )}
                        </div>
                        {doc.status === 'restored' && (
                          <span className="text-amber-500 text-xs">{doc.extractedPages.length} sig pages (saved)</span>
                        )}
                        {doc.status === 'processing' && doc.progress !== undefined && (
                          <div className="w-full bg-slate-200 rounded-full h-1.5 mt-1">
                            <div
                              className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                              style={{ width: `${doc.progress}%` }}
                            ></div>
                          </div>
                        )}
                     </div>
                  </div>

                  {/* Document Actions */}
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    {doc.status !== 'error' && doc.status !== 'restored' && (
                        <button
                        onClick={() => handlePreviewDocument(doc)}
                        className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-blue-500 transition-all mr-1"
                        title="Preview Document"
                        >
                        <Eye size={14} />
                        </button>
                    )}
                    <button
                      onClick={() => removeDocument(doc.id)}
                      className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 transition-all"
                      title="Remove Document"
                    >
                      <X size={14} />
                    </button>
                  </div>

               </div>
             ))}

             {documents.length === 0 && (
               <div className="text-center p-8 text-slate-400 text-sm">
                 No documents uploaded yet.
               </div>
             )}

             {/* Executed Uploads Section (Assembly Mode) */}
             {appMode === 'assembly' && (
               <>
                 <div className="border-t border-slate-200 my-2"></div>
                 <div className="px-2 pt-2">
                   <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Executed Pages</h2>
                   <div
                     className={`border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center text-center transition-colors cursor-pointer ${isDraggingExecuted ? 'border-green-500 bg-green-50' : 'border-slate-300 hover:border-green-400 hover:bg-slate-50'}`}
                     onDragOver={(e) => { e.preventDefault(); setIsDraggingExecuted(true); }}
                     onDragLeave={() => setIsDraggingExecuted(false)}
                     onDrop={(e) => {
                       e.preventDefault();
                       setIsDraggingExecuted(false);
                       handleExecutedFileUpload(e.dataTransfer.files);
                     }}
                   >
                     <input
                       type="file"
                       multiple
                       accept=".pdf"
                       className="hidden"
                       id="executedFileInput"
                       onChange={(e) => handleExecutedFileUpload(e.target.files)}
                     />
                     <label htmlFor="executedFileInput" className="cursor-pointer flex flex-col items-center">
                       <UploadCloud className="text-green-500 mb-1.5" size={20} />
                       <span className="text-xs font-medium text-slate-700">Upload Signed Pages</span>
                       <span className="text-[10px] text-slate-400 mt-0.5">Scanned or electronic</span>
                     </label>
                   </div>
                 </div>

                 {/* Executed uploads list */}
                 {executedUploads.map(upload => (
                   <div key={upload.id} className={`group relative flex items-center gap-3 p-3 rounded-md border transition-all ${
                     upload.status === 'error' ? 'bg-red-50 border-red-100' :
                     'hover:bg-slate-50 border-transparent hover:border-slate-100'
                   }`}>
                     <div className={`p-2 rounded ${
                       upload.status === 'error' ? 'bg-red-100 text-red-500' :
                       upload.status === 'completed' ? 'bg-green-100 text-green-600' :
                       'bg-slate-100 text-slate-500'
                     }`}>
                       <FileIcon size={16} />
                     </div>
                     <div className="flex-1 min-w-0">
                       <p className="text-sm font-medium truncate text-slate-700" title={upload.fileName}>{upload.fileName}</p>
                       <div className="text-xs text-slate-500 flex flex-col gap-1">
                         <div className="flex items-center gap-1">
                           {upload.status === 'processing' && <><Loader2 size={10} className="animate-spin" /> Analyzing...</>}
                           {upload.status === 'completed' && <><CheckCircle2 size={10} className="text-green-500" /> {upload.executedPages.filter(p => p.isConfirmedExecuted).length} signed pages</>}
                           {upload.status === 'error' && <span className="text-red-500">Error</span>}
                           {upload.status === 'pending' && 'Queued'}
                         </div>
                         {upload.status === 'processing' && upload.progress !== undefined && (
                           <div className="w-full bg-slate-200 rounded-full h-1.5 mt-1">
                             <div
                               className="bg-green-500 h-1.5 rounded-full transition-all duration-300"
                               style={{ width: `${upload.progress}%` }}
                             ></div>
                           </div>
                         )}
                       </div>
                     </div>
                     <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                       <button
                         onClick={() => removeExecutedUpload(upload.id)}
                         className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-500 transition-all"
                         title="Remove"
                       >
                         <X size={14} />
                       </button>
                     </div>
                   </div>
                 ))}
               </>
             )}
          </div>
        </div>

        {/* Main Content: Review Grid */}
        <div className="flex-1 flex flex-col bg-slate-50/50">
          
          {/* Toolbar */}
          <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between flex-shrink-0 shadow-sm z-10">
            <div className="flex items-center gap-4">
              {/* Mode Toggle */}
              <div className="flex bg-slate-100 p-1 rounded-md">
                <button
                  onClick={() => setAppMode('extract')}
                  className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${appMode === 'extract' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <FileText size={14} /> Extract
                </button>
                <button
                  onClick={() => setAppMode('assembly')}
                  disabled={allPages.length === 0}
                  className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${appMode === 'assembly' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  <ArrowLeftRight size={14} /> Assembly
                </button>
              </div>

              {/* Grouping toggle (only in extract mode) */}
              {appMode === 'extract' && (
                <div className="flex bg-slate-100 p-1 rounded-md">
                  <button
                    onClick={() => setGroupingMode('agreement')}
                    className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${groupingMode === 'agreement' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Layers size={14} /> Agreement
                  </button>
                  <button
                    onClick={() => setGroupingMode('counterparty')}
                    className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${groupingMode === 'counterparty' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Users size={14} /> Party
                  </button>
                  <button
                    onClick={() => setGroupingMode('signatory')}
                    className={`px-3 py-1.5 rounded text-xs font-medium flex items-center gap-2 transition-all ${groupingMode === 'signatory' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <UserPen size={14} /> Signatory
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Content Area with Nav */}
          <div className="flex-1 flex overflow-hidden">
            {/* Grid Area */}
            <div className="flex-1 overflow-y-auto p-6 scroll-smooth">

             {appMode === 'extract' ? (
               // --- Extract Mode Content ---
               <>
                 {displayedPages.length === 0 ? (
                   <div className="h-full flex flex-col items-center justify-center text-slate-400">
                      <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                        <Layers size={32} className="text-slate-300" />
                      </div>
                      <p className="text-lg font-medium text-slate-500">No signature pages found yet</p>
                      <p className="text-sm max-w-md text-center mt-2">Upload agreements (PDF) to begin extraction.</p>
                   </div>
                 ) : (
                    <div className="space-y-8 pb-20">
                       {/* Render grouping headers based on current mode */}
                       {displayedPages.reduce((acc: React.ReactNode[], page, idx, arr) => {
                          const prev = arr[idx-1];
                          let shouldInsertHeader = false;
                          let headerText = '';
                          let HeaderIcon = Layers;

                          if (groupingMode === 'agreement') {
                              shouldInsertHeader = !prev || prev.documentName !== page.documentName;
                              headerText = page.documentName;
                              HeaderIcon = FileText;
                          } else if (groupingMode === 'counterparty') {
                              shouldInsertHeader = !prev || prev.partyName !== page.partyName;
                              headerText = page.partyName;
                              HeaderIcon = Users;
                          } else {
                              // Signatory
                              const currentSig = page.signatoryName || 'Unknown Signatory';
                              const prevSig = prev?.signatoryName || 'Unknown Signatory';
                              shouldInsertHeader = !prev || prevSig !== currentSig;
                              headerText = currentSig;
                              HeaderIcon = UserPen;
                          }

                          if (shouldInsertHeader) {
                            const headerId = `group-${headerText.replace(/[^a-zA-Z0-9]/g, '_')}`;
                            acc.push(
                              <div id={headerId} key={`head-${headerText}-${idx}`} className="flex items-center gap-2 pb-2 border-b border-slate-200 mt-4 first:mt-0 scroll-mt-4">
                                <HeaderIcon size={16} className="text-slate-400" />
                                <h3 className="text-sm font-bold text-slate-700">{headerText}</h3>
                              </div>
                            );
                          }

                          acc.push(
                            <SignatureCard
                                key={page.id}
                                page={page}
                                existingParties={uniqueParties.filter(p => p !== 'All')}
                                onUpdateCopies={handleUpdateCopies}
                                onUpdateParty={handleUpdateParty}
                                onUpdateSignatory={handleUpdateSignatory}
                                onUpdateCapacity={handleUpdateCapacity}
                                onDelete={handleDeletePage}
                                onPreview={handlePreviewSignaturePage}
                            />
                          );
                          return acc;
                       }, [])}
                    </div>
                 )}
               </>
             ) : (
               // --- Assembly Mode Content ---
               <div className="space-y-6 pb-20">
                 {/* Completion Checklist Grid */}
                 <CompletionChecklist
                   blankPages={allPages}
                   matches={assemblyMatches}
                   executedPages={allExecutedPages}
                   onCellClick={handleChecklistCellClick}
                 />

                 {/* Executed Pages Cards */}
                 {allExecutedPages.length > 0 && (
                   <div className="space-y-3">
                     <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                       <Package size={16} className="text-slate-400" />
                       Uploaded Executed Pages ({allExecutedPages.filter(p => p.isConfirmedExecuted).length} signed)
                     </h3>
                     <div className="space-y-2">
                       {allExecutedPages.map(ep => (
                         <ExecutedPageCard
                           key={ep.id}
                           page={ep}
                           match={assemblyMatches.find(m => m.executedPageId === ep.id) || null}
                           onUnmatch={handleUnmatchByExecutedId}
                         />
                       ))}
                     </div>
                   </div>
                 )}

                 {allExecutedPages.length === 0 && (
                   <div className="h-64 flex flex-col items-center justify-center text-slate-400">
                     <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                       <ArrowLeftRight size={32} className="text-slate-300" />
                     </div>
                     <p className="text-lg font-medium text-slate-500">No executed pages yet</p>
                     <p className="text-sm max-w-md text-center mt-2">Upload signed PDFs in the sidebar to begin matching.</p>
                   </div>
                 )}
               </div>
             )}

            </div>

            {/* Right Nav Rail (Extract mode only) */}
            {appMode === 'extract' && displayedPages.length > 0 && (
              <div className="w-64 bg-white border-l border-slate-200 overflow-y-auto p-4 hidden xl:block flex-shrink-0">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Jump to {groupingMode === 'counterparty' ? 'Party' : groupingMode === 'signatory' ? 'Signatory' : 'Agreement'}
                </h3>
                <ul className="space-y-1">
                  {navigationGroups.map(g => (
                    <li key={g}>
                      <button
                        onClick={() => scrollToGroup(g)}
                        className="text-sm text-slate-600 hover:text-blue-600 hover:bg-slate-50 w-full text-left px-2 py-1.5 rounded transition-colors truncate"
                        title={g}
                      >
                        {g}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Floating Action Bar — Extract Mode */}
          {appMode === 'extract' && displayedPages.length > 0 && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-1 py-1 rounded-full shadow-xl flex items-center gap-1 z-20">
               <button
                 onClick={() => setIsInstructionsOpen(true)}
                 disabled={isProcessing}
                 className="px-5 py-2.5 rounded-full hover:bg-slate-800 transition-colors font-medium text-sm flex items-center gap-2 disabled:opacity-50"
               >
                 <FileText size={16} /> Instructions
               </button>
               <div className="w-px h-5 bg-slate-700"></div>
               <button
                 onClick={handleDownloadPack}
                 disabled={isProcessing}
                 className="px-5 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 transition-colors font-medium text-sm flex items-center gap-2 shadow-lg shadow-blue-900/20 disabled:opacity-50"
               >
                 {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                 Download
               </button>
            </div>
          )}

          {/* Floating Action Bar — Assembly Mode */}
          {appMode === 'assembly' && allExecutedPages.length > 0 && (
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-1 py-1 rounded-full shadow-xl flex items-center gap-1 z-20">
               <button
                 onClick={handleAutoMatch}
                 disabled={isProcessing || allExecutedPages.filter(p => p.isConfirmedExecuted).length === 0}
                 className="px-5 py-2.5 rounded-full hover:bg-slate-800 transition-colors font-medium text-sm flex items-center gap-2 disabled:opacity-50"
               >
                 <Wand2 size={16} /> Auto-Match
               </button>
               <div className="w-px h-5 bg-slate-700"></div>
               <button
                 onClick={handleAssembleDocuments}
                 disabled={isProcessing || assemblyMatches.length === 0}
                 className="px-5 py-2.5 rounded-full bg-green-600 hover:bg-green-500 transition-colors font-medium text-sm flex items-center gap-2 shadow-lg shadow-green-900/20 disabled:opacity-50"
               >
                 {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                 Assemble & Download
               </button>
            </div>
          )}

          {/* Status Toast */}
          {currentStatus && (
            <div className="absolute top-4 right-6 bg-white border border-slate-200 shadow-lg rounded-md px-4 py-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-4 z-50 max-w-sm">
               <Loader2 size={18} className="animate-spin text-blue-500" />
               <span className="text-sm font-medium text-slate-700">{currentStatus}</span>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default App;