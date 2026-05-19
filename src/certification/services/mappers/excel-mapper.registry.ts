import { ExcelRow } from './excel-mapper.interface';
import { mapE31 } from './excel-e31.mapper';
import { mapE32 } from './excel-e32.mapper';
import { mapE33 } from './excel-e33.mapper';
import { mapE34 } from './excel-e34.mapper';
import { mapE41 } from './excel-e41.mapper';
import { mapE43 } from './excel-e43.mapper';
import { mapE44 } from './excel-e44.mapper';
import { mapE45 } from './excel-e45.mapper';
import { mapE46 } from './excel-e46.mapper';
import { mapE47 } from './excel-e47.mapper';

type MapperFn = (row: ExcelRow, companyId: string) => Record<string, unknown>;

const REGISTRY: Record<string, MapperFn> = {
  '31': mapE31,
  '32': mapE32,
  '33': mapE33,
  '34': mapE34,
  '41': mapE41,
  '43': mapE43,
  '44': mapE44,
  '45': mapE45,
  '46': mapE46,
  '47': mapE47,
};

/**
 * Return the mapper function for the given TipoeCF value.
 * Accepts both "31" (Excel) and "E31" (full eNCF prefix).
 */
export function getMapper(tipoEcf: string | number): MapperFn | undefined {
  const key = String(tipoEcf).replace(/^E/, '');
  return REGISTRY[key];
}
