#!/usr/bin/env python3
"""Queryspace local SQL workspace — standard-library SQLite and web server."""
from __future__ import annotations
import base64, csv, datetime, io, json, math, mimetypes, os, re, sqlite3, sys, time, traceback, zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / '.queryspace-data'
DB_PATH = DATA_DIR / 'queryspace.sqlite3'
MAX_UPLOAD = 24 * 1024 * 1024
MAX_ROWS_OUT = 500


def quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def safe_table_name(name: str) -> str:
    cleaned = re.sub(r'[^\w]+', '_', str(name or '').strip(), flags=re.UNICODE).strip('_')
    if not cleaned:
        cleaned = 'imported_table'
    if cleaned[0].isdigit():
        cleaned = 'table_' + cleaned
    return cleaned[:80]


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=8)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA journal_mode=WAL')
    return db


def init_db():
    with connect() as db:
        db.execute('CREATE TABLE IF NOT EXISTS "_qs_imports" (table_name TEXT PRIMARY KEY, source_file TEXT NOT NULL, worksheet TEXT, imported_at TEXT NOT NULL, row_count INTEGER NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS "_qs_saved_queries" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sql TEXT NOT NULL, updated_at TEXT NOT NULL)')
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customers'").fetchone():
            db.execute('CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, plan TEXT NOT NULL, monthly_spend REAL NOT NULL, status TEXT NOT NULL, city TEXT NOT NULL)')
            db.executemany('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?)', [
                (1,'Atlas Studio','Growth',4280.0,'active','Austin'),(2,'Northstar Labs','Scale',3840.0,'active','Seattle'),(3,'Common Ground','Growth',2760.0,'active','Denver'),(4,'Paper Plane Co.','Starter',1920.0,'active','Brooklyn'),(5,'Sunroom Health','Growth',1640.0,'active','Portland'),(6,'Signal & Soil','Starter',920.0,'paused','Chicago')])
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").fetchone():
            db.execute('CREATE TABLE orders (order_id INTEGER PRIMARY KEY, order_date TEXT NOT NULL, customer_id INTEGER NOT NULL, total REAL NOT NULL, status TEXT NOT NULL)')
            db.executemany('INSERT INTO orders VALUES (?, ?, ?, ?, ?)', [
                (1001,'2026-11-16',1,1290.00,'paid'),(1002,'2026-11-15',2,840.00,'paid'),(1003,'2026-11-14',3,420.00,'paid'),(1004,'2026-11-13',1,1620.00,'paid'),(1005,'2026-11-12',4,280.00,'pending'),(1006,'2026-11-11',5,960.00,'paid'),(1007,'2026-11-10',2,740.00,'paid'),(1008,'2026-11-09',3,540.00,'refunded')])
        if db.execute('SELECT COUNT(*) FROM "_qs_saved_queries"').fetchone()[0] == 0:
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            db.executemany('INSERT INTO "_qs_saved_queries" (name,sql,updated_at) VALUES (?,?,?)', [
                ('Active customers', "SELECT customer_name, plan, monthly_spend, city\nFROM customers\nWHERE status = 'active'\nORDER BY monthly_spend DESC;", now),
                ('Recent orders', "SELECT order_id, order_date, customer_id, total, status\nFROM orders\nORDER BY order_date DESC\nLIMIT 10;", now)])


def sql_type(values):
    present = [v for v in values if v is not None and str(v).strip() != '']
    if not present: return 'TEXT'
    if all(isinstance(v, bool) or isinstance(v, int) for v in present): return 'INTEGER'
    if all(isinstance(v, (bool, int, float)) and not isinstance(v, str) for v in present): return 'REAL'
    # CSV values begin as text; infer whole columns without turning identifier-like values into numbers.
    texts = [str(v).strip() for v in present]
    if all(re.fullmatch(r'[+-]?\d+', v) for v in texts):
        digits=[v.lstrip('+-') for v in texts]
        # Keep identifiers and large integers intact rather than stripping zeros or precision.
        if all(d=='0' or not d.startswith('0') for d in digits) and all(len(d)<16 for d in digits): return 'INTEGER'
        return 'TEXT'
    if all(re.fullmatch(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?', v) for v in texts): return 'REAL'
    return 'TEXT'


def cast_value(value, kind):
    if value is None or str(value).strip() == '': return None
    if kind == 'INTEGER':
        try: return int(float(value))
        except (ValueError, TypeError, OverflowError): return str(value)
    if kind == 'REAL':
        try:
            number = float(value)
            return number if math.isfinite(number) else str(value)
        except (ValueError, TypeError, OverflowError): return str(value)
    if isinstance(value, (dict, list)): return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def normalize_headers(headers):
    normalized, used = [], set()
    for i, raw in enumerate(headers, 1):
        base = re.sub(r'[^\w]+', '_', str(raw or '').strip(), flags=re.UNICODE).strip('_') or f'column_{i}'
        if base[0].isdigit(): base = 'column_' + base
        candidate, suffix = base[:80], 2
        while candidate.casefold() in used:
            candidate = f'{base[:72]}_{suffix}'
            suffix += 1
        used.add(candidate.casefold())
        normalized.append(candidate)
    return normalized


def read_csv_rows(filename, blob):
    try: text = blob.decode('utf-8-sig')
    except UnicodeDecodeError:
        try: text = blob.decode('cp1252')
        except UnicodeDecodeError as exc: raise ValueError('This CSV is not readable as UTF-8 or Windows text.') from exc
    sample = text[:8192]
    try: dialect = csv.Sniffer().sniff(sample, delimiters=',;\t|')
    except csv.Error: dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text, newline=''), dialect))
    rows = [row for row in rows if any(str(cell).strip() for cell in row)]
    if len(rows) < 2: raise ValueError('The file needs a header row and at least one data row.')
    headers = normalize_headers(rows[0])
    result = []
    for row in rows[1:]:
        result.append([(cell.strip() if cell.strip() != '' else None) for cell in (row + [''] * len(headers))[:len(headers)]])
    return headers, result, None


def _xml_text(node):
    return ''.join((el.text or '') for el in node.iter() if el.tag.endswith('}t'))


def read_xlsx_sheets(blob):
    try: zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as exc: raise ValueError('This Excel file is damaged or is not an .xlsx workbook.') from exc
    with zf:
        names = set(zf.namelist())
        if 'xl/workbook.xml' not in names: raise ValueError('This Excel workbook is missing its workbook data.')
        if sum(info.file_size for info in zf.infolist()) > 100 * 1024 * 1024: raise ValueError('This workbook expands beyond the 100 MB safety limit.')
        ns = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships','p':'http://schemas.openxmlformats.org/package/2006/relationships'}
        shared=[]
        if 'xl/sharedStrings.xml' in names:
            root = ET.fromstring(zf.read('xl/sharedStrings.xml'))
            shared = [_xml_text(si) for si in root.findall('m:si',ns)]
        relmap={}
        rel_path='xl/_rels/workbook.xml.rels'
        if rel_path in names:
            relroot=ET.fromstring(zf.read(rel_path))
            for rel in relroot:
                target=rel.attrib.get('Target','')
                if target.startswith('/'): path=target.lstrip('/')
                else: path='xl/'+target.replace('\\','/')
                # Normalize ../ segments without extracting the archive.
                bits=[]
                for bit in path.split('/'):
                    if bit=='..':
                        if bits: bits.pop()
                    elif bit and bit!='.': bits.append(bit)
                relmap[rel.attrib.get('Id')]='/'.join(bits)
        workbook=ET.fromstring(zf.read('xl/workbook.xml'))
        sheet_defs=[]
        for sh in workbook.findall('.//m:sheets/m:sheet',ns):
            rid=sh.attrib.get('{%s}id'%ns['r'])
            path=relmap.get(rid, 'xl/worksheets/sheet%d.xml'%(len(sheet_defs)+1))
            if path in names: sheet_defs.append((sh.attrib.get('name','Sheet'),path))
        if not sheet_defs: raise ValueError('No readable worksheet was found in this Excel file.')
        parsed={}
        for sheet_name,path in sheet_defs:
            root=ET.fromstring(zf.read(path))
            raw_rows=[]
            for row_el in root.findall('.//m:sheetData/m:row',ns):
                cells=[]
                for cell in row_el.findall('m:c',ns):
                    ref=cell.attrib.get('r','A1')
                    col_letters=re.match(r'([A-Z]+)',ref.upper())
                    col_index=0
                    if col_letters:
                        for char in col_letters.group(1): col_index=col_index*26+ord(char)-64
                        col_index-=1
                    while len(cells)<=col_index: cells.append(None)
                    typ=cell.attrib.get('t'); val_el=cell.find('m:v',ns)
                    if typ=='inlineStr': value=_xml_text(cell.find('m:is',ns)) if cell.find('m:is',ns) is not None else ''
                    elif val_el is None: value=None
                    else:
                        raw=val_el.text or ''
                        if typ=='s':
                            try: value=shared[int(raw)]
                            except (ValueError,IndexError): value=raw
                        elif typ=='b': value=(raw=='1')
                        elif typ in ('str','e'): value=raw
                        else:
                            try:
                                num=float(raw)
                                value=int(num) if num.is_integer() and abs(num)<9e15 else num
                            except ValueError: value=raw
                    cells[col_index]=value
                raw_rows.append(cells)
            raw_rows=[r for r in raw_rows if any(v is not None and str(v).strip() for v in r)]
            if raw_rows:
                width=max(len(r) for r in raw_rows)
                raw_rows=[r+[None]*(width-len(r)) for r in raw_rows]
                parsed[sheet_name]=raw_rows
        return parsed


def inspect_file(filename, blob, sheet_name=None):
    ext=Path(filename).suffix.lower()
    if len(blob)>MAX_UPLOAD: raise ValueError('Files must be 24 MB or smaller.')
    if ext in ('.csv','.tsv','.txt'):
        headers, rows, _=read_csv_rows(filename,blob)
        return {'format':'csv','sheets':[],'sheet':None,'headers':headers,'rows':rows,'count':len(rows)}
    if ext in ('.xlsx','.xlsm'):
        sheets=read_xlsx_sheets(blob)
        selected=sheet_name if sheet_name in sheets else next(iter(sheets))
        raw=sheets[selected]
        if len(raw)<2: raise ValueError(f'Worksheet "{selected}" needs a header row and at least one data row.')
        headers=normalize_headers(raw[0])
        rows=[(r+[None]*len(headers))[:len(headers)] for r in raw[1:]]
        rows=[r for r in rows if any(v is not None and str(v).strip() for v in r)]
        return {'format':'excel','sheets':list(sheets.keys()),'sheet':selected,'headers':headers,'rows':rows,'count':len(rows)}
    if ext=='.xls': raise ValueError('This older .xls file needs to be saved as .xlsx in Excel before importing.')
    raise ValueError('Choose a .csv, .tsv, .xlsx, or .xlsm file.')


def public_table_info(db, name):
    columns=[{'name':r['name'],'type':r['type'] or 'TEXT','notnull':bool(r['notnull']),'primary':bool(r['pk'])} for r in db.execute('PRAGMA table_info('+quote_ident(name)+')')]
    count=db.execute('SELECT COUNT(*) FROM '+quote_ident(name)).fetchone()[0]
    imported=db.execute('SELECT source_file, worksheet, imported_at FROM "_qs_imports" WHERE table_name=?',(name,)).fetchone()
    return {'name':name,'columns':columns,'row_count':count,'source':dict(imported) if imported else None}


def public_relationships(db, names):
    """Return declared SQLite foreign keys plus unambiguous matching primary-key names."""
    name_set={name.casefold() for name in names}
    relationships=[]; seen=set()
    def add(source, source_column, target, target_column, method):
        if source.casefold()==target.casefold() or target.casefold() not in name_set: return
        key=(source.casefold(),str(source_column).casefold(),target.casefold(),str(target_column).casefold())
        if key in seen: return
        seen.add(key)
        relationships.append({'from_table':source,'from_column':source_column,'to_table':target,'to_column':target_column,'method':method})
    infos={name:[dict(r) for r in db.execute('PRAGMA table_info('+quote_ident(name)+')')] for name in names}
    for source in names:
        for fk in db.execute('PRAGMA foreign_key_list('+quote_ident(source)+')'):
            target=fk['table']; source_col=fk['from']; target_col=fk['to']
            if target in infos and (not target_col):
                target_col=next((c['name'] for c in infos[target] if c['pk']),source_col)
            add(source,source_col,target,target_col,'foreign key')
    primary_by_name={}
    for target,cols in infos.items():
        for column in cols:
            if column['pk']:
                primary_by_name.setdefault(column['name'].casefold(),[]).append((target,column['name']))
    for source,cols in infos.items():
        for column in cols:
            col_name=column['name']
            if column['pk'] or not col_name.casefold().endswith('_id'): continue
            candidates=[pair for pair in primary_by_name.get(col_name.casefold(),[]) if pair[0].casefold()!=source.casefold()]
            if len(candidates)==1:
                target,target_col=candidates[0]
                add(source,col_name,target,target_col,'matching key')
    relationships.sort(key=lambda edge:(edge['from_table'].casefold(),edge['from_column'].casefold(),edge['to_table'].casefold()))
    return relationships


class Handler(SimpleHTTPRequestHandler):
    server_version='QueryspaceLocal/1.0'
    CORS_ORIGINS={'http://127.0.0.1:5501','http://localhost:5501'}
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,fmt,*args): print('[%s] %s'%(self.log_date_time_string(),fmt%args),flush=True)
    def send_cors_headers(self):
        origin=self.headers.get('Origin','')
        if origin in self.CORS_ORIGINS:
            self.send_header('Access-Control-Allow-Origin',origin)
            self.send_header('Vary','Origin')
    def do_OPTIONS(self):
        if urlparse(self.path).path.startswith('/api/') and self.headers.get('Origin','') in self.CORS_ORIGINS:
            self.send_response(204)
            self.send_cors_headers()
            self.send_header('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers','Content-Type')
            self.send_header('Access-Control-Max-Age','600')
            self.end_headers()
            return
        self.send_error(403)
    def send_json(self,obj,status=200):
        raw=json.dumps(obj,ensure_ascii=False,allow_nan=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(raw))); self.send_header('Cache-Control','no-store'); self.send_cors_headers(); self.end_headers(); self.wfile.write(raw)
    def body_json(self):
        length=int(self.headers.get('Content-Length','0'))
        if length>MAX_UPLOAD*2: raise ValueError('Request is too large (24 MB file limit).')
        raw=self.rfile.read(length)
        try: return json.loads(raw or b'{}')
        except json.JSONDecodeError as exc: raise ValueError('Request body must be valid JSON.') from exc
    def do_GET(self):
        path=urlparse(self.path).path
        try:
            if path=='/api/status':
                with connect() as db: tables=[r['name'] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_qs_%' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
                return self.send_json({'ok':True,'engine':'SQLite','database':'queryspace.sqlite3','table_count':len(tables)})
            if path=='/api/tables':
                with connect() as db:
                    names=[r['name'] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_qs_%' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE")]
                    return self.send_json({'tables':[public_table_info(db,n) for n in names],'relationships':public_relationships(db,names)})
            if path=='/api/table':
                params=parse_qs(urlparse(self.path).query); name=params.get('name',[''])[0]
                with connect() as db:
                    exists=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? AND name NOT LIKE '_qs_%' AND name NOT LIKE 'sqlite_%'",(name,)).fetchone()
                    if not exists: return self.send_json({'error':'That table was not found.'},404)
                    info=public_table_info(db,name)
                    rows=db.execute('SELECT * FROM '+quote_ident(name)+' LIMIT 100').fetchall()
                    return self.send_json({'table':info,'columns':[c['name'] for c in info['columns']],'rows':[dict(r) for r in rows]})
            if path=='/api/queries':
                with connect() as db:
                    rows=db.execute('SELECT id,name,sql,updated_at FROM "_qs_saved_queries" ORDER BY updated_at DESC,id DESC').fetchall()
                    return self.send_json({'queries':[dict(r) for r in rows]})
            if path.startswith('/api/'): return self.send_json({'error':'Unknown API route.'},404)
        except Exception as exc: return self.send_json({'error':str(exc)},500)
        if path=='/' : self.path='/index.html'
        relative=Path(unquote(urlparse(self.path).path).lstrip('/'))
        resolved=(ROOT/relative).resolve()
        if (not resolved.is_relative_to(ROOT) or any(part.startswith('.') for part in relative.parts)
                or resolved.name.lower() in {'server.py','start_queryspace.bat','readme-queryspace.md'}):
            return self.send_error(404)
        return super().do_GET()
    def do_POST(self):
        path=urlparse(self.path).path
        try:
            payload=self.body_json()
            if path in ('/api/inspect','/api/import'):
                filename=Path(str(payload.get('filename') or 'upload.csv')).name
                try: blob=base64.b64decode(payload.get('data_base64',''),validate=True)
                except Exception: raise ValueError('The uploaded file could not be decoded.')
                preview=inspect_file(filename,blob,payload.get('worksheet'))
                if path=='/api/inspect':
                    return self.send_json({'format':preview['format'],'sheets':preview['sheets'],'sheet':preview['sheet'],'headers':preview['headers'],'sample_rows':preview['rows'][:5],'row_count':preview['count']})
                table=safe_table_name(payload.get('table_name') or Path(filename).stem)
                headers=preview['headers']; rows=preview['rows']
                if not rows: raise ValueError('This file has no data rows to import.')
                kinds=[sql_type([row[i] if i<len(row) else None for row in rows]) for i in range(len(headers))]
                with connect() as db:
                    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
                        return self.send_json({'error':f'Table "{table}" already exists. Choose another table name; existing data was not changed.'},409)
                    defs=', '.join(quote_ident(h)+' '+k for h,k in zip(headers,kinds))
                    db.execute('CREATE TABLE '+quote_ident(table)+' ('+defs+')')
                    marks=','.join('?' for _ in headers)
                    converted=[[cast_value(row[i] if i<len(row) else None,kinds[i]) for i in range(len(headers))] for row in rows]
                    db.executemany('INSERT INTO '+quote_ident(table)+' VALUES ('+marks+')',converted)
                    db.execute('INSERT INTO "_qs_imports" (table_name,source_file,worksheet,imported_at,row_count) VALUES (?,?,?,?,?)',(table,filename,preview['sheet'],datetime.datetime.now(datetime.timezone.utc).isoformat(),len(converted)))
                return self.send_json({'ok':True,'table':table,'row_count':len(rows),'columns':[{'name':h,'type':k} for h,k in zip(headers,kinds)],'worksheet':preview['sheet'],'source_file':filename},201)
            if path=='/api/query':
                sql=str(payload.get('sql') or '').strip()
                if not sql: raise ValueError('Enter a SQL statement first.')
                started=time.perf_counter()
                with connect() as db:
                    db.set_progress_handler(lambda: 1 if time.perf_counter()-started>8 else 0, 10000)
                    try: cur=db.execute(sql)
                    except sqlite3.ProgrammingError as exc:
                        msg=str(exc)
                        if 'one statement' in msg.lower(): msg='Run one SQL statement at a time.'
                        raise ValueError(msg) from exc
                    columns=[d[0] for d in cur.description] if cur.description else []
                    if columns:
                        raw=cur.fetchmany(MAX_ROWS_OUT+1); truncated=len(raw)>MAX_ROWS_OUT; raw=raw[:MAX_ROWS_OUT]
                        rows=[list(r) for r in raw]
                        return self.send_json({'ok':True,'columns':columns,'rows':rows,'row_count':len(rows),'truncated':truncated,'elapsed_ms':round((time.perf_counter()-started)*1000,1),'message':f'Returned {len(rows)} row'+('s' if len(rows)!=1 else '')+(' (display capped at 500).' if truncated else '')})
                    return self.send_json({'ok':True,'columns':[],'rows':[],'row_count':cur.rowcount,'truncated':False,'elapsed_ms':round((time.perf_counter()-started)*1000,1),'message':'Statement completed successfully.'})
            if path=='/api/queries':
                name=str(payload.get('name') or '').strip()[:100]
                sql=str(payload.get('sql') or '').strip()
                if not name: raise ValueError('Give this saved query a name.')
                if not sql: raise ValueError('There is no SQL to save.')
                now=datetime.datetime.now(datetime.timezone.utc).isoformat()
                with connect() as db:
                    cur=db.execute('INSERT INTO "_qs_saved_queries" (name,sql,updated_at) VALUES (?,?,?)',(name,sql,now))
                    saved=db.execute('SELECT id,name,sql,updated_at FROM "_qs_saved_queries" WHERE id=?',(cur.lastrowid,)).fetchone()
                return self.send_json({'ok':True,'query':dict(saved)},201)
            return self.send_json({'error':'Unknown API route.'},404)
        except ValueError as exc: return self.send_json({'error':str(exc)},400)
        except sqlite3.Error as exc: return self.send_json({'error':str(exc)},400)
        except Exception as exc:
            traceback.print_exc()
            return self.send_json({'error':'The local database could not complete that request: '+str(exc)},500)
    def do_DELETE(self):
        path=urlparse(self.path).path
        try:
            if path.startswith('/api/queries/'):
                raw=path.rsplit('/',1)[-1]
                if not raw.isdigit(): return self.send_json({'error':'Invalid saved query id.'},400)
                with connect() as db: cur=db.execute('DELETE FROM "_qs_saved_queries" WHERE id=?',(int(raw),))
                if not cur.rowcount: return self.send_json({'error':'Saved query not found.'},404)
                return self.send_json({'ok':True,'deleted_id':int(raw)})
            return self.send_json({'error':'Unknown API route.'},404)
        except Exception as exc: return self.send_json({'error':str(exc)},500)


def main():
    init_db()
    port=int(os.environ.get('QUERYSPACE_PORT','5502'))
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    server.daemon_threads=True
    print(f'Queryspace SQLite workspace ready at http://127.0.0.1:{port}/index.html',flush=True)
    print(f'Persistent database: {DB_PATH}',flush=True)
    try: server.serve_forever(poll_interval=.4)
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
