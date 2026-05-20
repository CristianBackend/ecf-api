/**
 * DgiiService — parseStatusResponse regression tests (Fix 4d).
 *
 * DGII's XML response uses <Codigo>N</Codigo> for the numeric status code
 * and <Estado>Aceptado</Estado> for the textual form. The pre-Fix 4d parser
 * looked for <estado>(\d+)</estado>, which never matched, so every accepted
 * invoice received status=0 (NOT_FOUND) and the poll processor mapped it to
 * SENT instead of ACCEPTED. These tests pin the corrected parsing so a
 * future refactor cannot regress to the old behavior.
 */
import { DgiiService } from './dgii.service';
import { DGII_STATUS } from '../xml-builder/ecf-types';

// Access the private parseStatusResponse method via prototype for unit testing.
// This is intentionally a unit test of the parser only, no I/O.
type ParseFn = (trackId: string, responseText: string) => {
  trackId: string;
  status: number;
  message: string;
  encf?: string;
  secuenciaUtilizada?: boolean;
  rawResponse: string;
};
const parseStatusResponse: ParseFn = (DgiiService.prototype as any).parseStatusResponse.bind({});

describe('DgiiService.parseStatusResponse (Fix 4d)', () => {
  const TRACK_ID = '06341291-5e41-46a6-91fc-65ec136f05e3';

  it('parses ACCEPTED from real DGII XML with <Codigo>1</Codigo>', () => {
    // Real response received during DGII certification for E310000000006.
    const xml = `<RespuestaConsultaTrackId xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><TrackId>${TRACK_ID}</TrackId><Codigo>1</Codigo><Estado>Aceptado</Estado><Rnc>133158744</Rnc><Encf>E310000000006</Encf><SecuenciaUtilizada>false</SecuenciaUtilizada><FechaRecepcion>5/20/2026 4:38:38 PM</FechaRecepcion><Mensajes><Mensaje><Valor /><Codigo>0</Codigo></Mensaje></Mensajes></RespuestaConsultaTrackId>`;

    const result = parseStatusResponse(TRACK_ID, xml);

    expect(result.status).toBe(DGII_STATUS.ACCEPTED);
    expect(result.trackId).toBe(TRACK_ID);
    expect(result.encf).toBe('E310000000006');
    expect(result.secuenciaUtilizada).toBe(false);
  });

  it('does NOT read the inner <Mensaje><Codigo>0</Codigo> by mistake', () => {
    // Subtle guard: the top-level <Codigo>1</Codigo> must win over the inner
    // <Mensaje><Codigo>0</Codigo>. A naive regex without anchoring would
    // match the FIRST occurrence (1) but could be tempted by greedy patterns
    // to match the second (0).
    const xml = `<Resp><TrackId>x</TrackId><Codigo>1</Codigo><Estado>Aceptado</Estado><Mensajes><Mensaje><Valor>warning</Valor><Codigo>0</Codigo></Mensaje></Mensajes></Resp>`;
    const result = parseStatusResponse('x', xml);
    expect(result.status).toBe(DGII_STATUS.ACCEPTED);
  });

  it('parses REJECTED from <Codigo>2</Codigo>', () => {
    const xml = `<Resp><TrackId>x</TrackId><Codigo>2</Codigo><Estado>Rechazado</Estado></Resp>`;
    expect(parseStatusResponse('x', xml).status).toBe(DGII_STATUS.REJECTED);
  });

  it('parses CONDITIONAL from <Codigo>4</Codigo>', () => {
    const xml = `<Resp><TrackId>x</TrackId><Codigo>4</Codigo><Estado>Aceptado Condicional</Estado></Resp>`;
    expect(parseStatusResponse('x', xml).status).toBe(DGII_STATUS.CONDITIONAL);
  });

  it('falls back to textual <Estado> when <Codigo> is absent', () => {
    const xml = `<Resp><TrackId>x</TrackId><Estado>Aceptado</Estado></Resp>`;
    expect(parseStatusResponse('x', xml).status).toBe(DGII_STATUS.ACCEPTED);
  });

  it('disambiguates "Aceptado Condicional" before "Aceptado"', () => {
    // "Aceptado Condicional" contains the substring "Aceptado".
    // The textual fallback must check the longer string first.
    const xml = `<Resp><TrackId>x</TrackId><Estado>Aceptado Condicional</Estado></Resp>`;
    expect(parseStatusResponse('x', xml).status).toBe(DGII_STATUS.CONDITIONAL);
  });

  it('still parses legacy lowercase <estado>N</estado> shape', () => {
    // Backwards-compat sanity for any non-standard environment that may have
    // used lowercase tags. Must not regress.
    const xml = `<Resp><trackId>x</trackId><estado>1</estado></Resp>`;
    expect(parseStatusResponse('x', xml).status).toBe(DGII_STATUS.ACCEPTED);
  });

  it('parses JSON responses (estado field)', () => {
    const json = JSON.stringify({ estado: 1, mensaje: 'OK', encf: 'E310000000001' });
    const result = parseStatusResponse('t', json);
    expect(result.status).toBe(1);
    expect(result.encf).toBe('E310000000001');
  });

  it('returns NOT_FOUND when neither Codigo nor Estado present', () => {
    const xml = `<Resp><TrackId>x</TrackId></Resp>`;
    expect(parseStatusResponse('x', xml).status).toBe(DGII_STATUS.NOT_FOUND);
  });
});
