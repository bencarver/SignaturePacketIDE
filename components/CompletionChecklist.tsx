import React from 'react';
import { ExtractedSignaturePage, AssemblyMatch, ExecutedSignaturePage } from '../types';
import { CheckCircle2, AlertTriangle, Minus } from 'lucide-react';

interface CompletionChecklistProps {
  blankPages: ExtractedSignaturePage[];
  matches: AssemblyMatch[];
  executedPages: ExecutedSignaturePage[];
  onCellClick: (blankPageId: string, currentMatch: AssemblyMatch | null) => void;
}

interface CellData {
  blankPage: ExtractedSignaturePage;
  match: AssemblyMatch | null;
}

const CompletionChecklist: React.FC<CompletionChecklistProps> = ({
  blankPages,
  matches,
  executedPages,
  onCellClick,
}) => {
  // Build unique document names (rows) and party+signatory combos (columns)
  const docNameSet = new Set<string>();
  blankPages.forEach(p => docNameSet.add(p.documentName));
  const documentNames = Array.from(docNameSet).sort();

  // Build unique party columns — use partyName as primary, with signatoryName as sub-label
  const partyKeySet = new Set<string>();
  blankPages.forEach(p => partyKeySet.add(`${p.partyName}|||${p.signatoryName}`));
  const partyKeys = Array.from(partyKeySet).sort();

  const parties = partyKeys.map((key: string) => {
    const [partyName, signatoryName] = key.split('|||');
    return { partyName, signatoryName, key };
  });

  // Build match lookup: blankPageId → AssemblyMatch
  const matchByBlankId = new Map<string, AssemblyMatch>();
  for (const match of matches) {
    matchByBlankId.set(match.blankPageId, match);
  }

  // Build the grid: for each (document, party) cell, find the corresponding blank page(s)
  const getCell = (docName: string, partyKey: string): CellData | null => {
    const parts = partyKey.split('|||');
    const partyName = parts[0];
    const signatoryName = parts[1];
    const blank = blankPages.find(
      p => p.documentName === docName && p.partyName === partyName && p.signatoryName === signatoryName
    );
    if (!blank) return null; // No sig page for this combination
    const match = matchByBlankId.get(blank.id) || null;
    return { blankPage: blank, match };
  };

  // Summary counts
  const totalRequired = blankPages.length;
  const totalMatched = matches.length;
  const progressPct = totalRequired > 0 ? Math.round((totalMatched / totalRequired) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 bg-white border border-slate-200 rounded-lg px-4 py-3">
        <div className="flex-1">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="font-medium text-slate-700">
              Assembly Progress
            </span>
            <span className={`font-bold ${totalMatched === totalRequired && totalRequired > 0 ? 'text-green-600' : 'text-slate-600'}`}>
              {totalMatched}/{totalRequired} matched
            </span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                totalMatched === totalRequired && totalRequired > 0
                  ? 'bg-green-500'
                  : 'bg-blue-500'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-semibold text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[200px]">
                  Document
                </th>
                {parties.map(p => (
                  <th key={p.key} className="text-center px-3 py-3 font-medium text-slate-600 min-w-[140px]">
                    <div className="text-xs">{p.partyName}</div>
                    {p.signatoryName && (
                      <div className="text-[10px] text-slate-400 font-normal">{p.signatoryName}</div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documentNames.map(docName => (
                <tr key={docName} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3 font-medium text-slate-700 sticky left-0 bg-white z-10">
                    <span className="truncate block max-w-[250px]" title={docName}>
                      {docName}
                    </span>
                  </td>
                  {parties.map(p => {
                    const cell = getCell(docName, p.key);

                    if (!cell) {
                      // No signature page for this combination
                      return (
                        <td key={p.key} className="text-center px-3 py-3">
                          <div className="flex items-center justify-center">
                            <Minus size={16} className="text-slate-200" />
                          </div>
                        </td>
                      );
                    }

                    const isMatched = !!cell.match;

                    return (
                      <td key={p.key} className="text-center px-3 py-3">
                        <button
                          onClick={() => onCellClick(cell.blankPage.id, cell.match)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                            isMatched
                              ? 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'
                              : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                          }`}
                          title={isMatched ? `Matched (${cell.match!.status})` : 'Click to assign'}
                        >
                          {isMatched ? (
                            <>
                              <CheckCircle2 size={14} />
                              {cell.match!.status === 'auto-matched' ? 'Auto' : 'Manual'}
                            </>
                          ) : (
                            <>
                              <AlertTriangle size={14} />
                              Pending
                            </>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CompletionChecklist;
