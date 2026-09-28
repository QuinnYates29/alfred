import { describe, expect, it } from 'vitest';
import { boardPatch, validateBoard } from '../../web/src/views/board/Settings.jsx';

const col = (id: string, name: string, extra = {}) => ({ id, name, kind: 'todo', wip: null, ...extra });
const fld = (id: string, name: string, extra = {}) => ({ id, name, type: 'text', ...extra });

describe('validateBoard', () => {
  it('accepts a sane board', () => {
    expect(validateBoard({ name: 'Alfred', columns: [col('todo', 'To do')], fields: [] })).toBeNull();
  });
  it('rejects blank name / no columns / blank column or field names / duplicate ids', () => {
    expect(validateBoard({ name: ' ', columns: [col('a', 'A')], fields: [] })).toMatch(/name/i);
    expect(validateBoard({ name: 'B', columns: [], fields: [] })).toMatch(/column/i);
    expect(validateBoard({ name: 'B', columns: [col('a', '')], fields: [] })).toMatch(/column/i);
    expect(validateBoard({ name: 'B', columns: [col('a', 'A')], fields: [fld('f', ' ')] })).toMatch(/field/i);
    expect(validateBoard({ name: 'B', columns: [col('a', 'A'), col('a', 'B')], fields: [] })).toMatch(/unique/i);
  });
});

describe('boardPatch', () => {
  it('trims names and maps empty wip to null', () => {
    const p: any = boardPatch({
      name: '  My board ',
      columns: [col('a', '  To do  ', { wip: '' }), col('b', 'Doing', { wip: '3' })],
      fields: [fld('f1', ' Effort ')],
      removedIds: [],
      moveTo: '',
    });
    expect(p.name).toBe('My board');
    expect(p.columns[0]).toEqual({ id: 'a', name: 'To do', kind: 'todo', wip: null });
    expect(p.columns[1].wip).toBe(3);
    expect(p.fields[0]).toEqual({ id: 'f1', name: 'Effort', type: 'text' });
    expect(p.moveTo).toBeUndefined();
  });

  it('keeps options only for select fields and sends moveTo when columns were removed', () => {
    const p: any = boardPatch({
      name: 'B',
      columns: [col('a', 'A')],
      fields: [
        fld('f1', 'Plan', { type: 'select', options: ['x', 'y'] }),
        fld('f2', 'Note', { type: 'text', options: ['ignored'] }),
      ],
      removedIds: ['gone'],
      moveTo: 'a',
    });
    expect(p.fields[0].options).toEqual(['x', 'y']);
    expect(p.fields[1].options).toBeUndefined();
    expect(p.moveTo).toBe('a');
  });
});
