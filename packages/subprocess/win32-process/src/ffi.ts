/** Lazy Koffi bindings for generic Win32 process, stdio, and Job operations. */

import { createRequire } from 'node:module'
import * as abi from './abi.ts'
import { Win32Error } from './errors.ts'

declare const nativePtr: unique symbol
/** Koffi native pointer branded against accidental numeric use. */
export type NativePtr = bigint & { readonly [nativePtr]: true }

/** Koffi's static type, erased at runtime. */
type Koffi = typeof import('koffi')['default']

type Ptr = ReturnType<Koffi['pointer']>
type StructType = ReturnType<Koffi['struct']>

let cachedKoffi: Koffi | undefined

/**
 * Load the native FFI binding on first use
 * Importing this module must not need koffi, because platforms without a prebuilt
 * binary have to be able to load it and then never call into it
 * @returns the cached koffi module.
 */
export function koffi(): Koffi {
  if (cachedKoffi === undefined) {
    const loaded = createRequire(import.meta.url)('koffi') as Koffi & { default?: Koffi }
    // A CJS bridge can hand back the module namespace instead of the object its
    // named exports hang off, so fall back to that namespace's default export
    // The fallback arm depends on the shape of koffi's CJS bridge rather than on any input,
    // and that bridge always hands back an object whose default export carries `pointer`
    /* v8 ignore next -- no input reaches the fallback arm */
    cachedKoffi = (typeof loaded.default?.pointer === 'function' ? loaded.default : loaded) as Koffi
  }
  return cachedKoffi
}

let cachedPvoid: Ptr | undefined
let cachedPpvoid: Ptr | undefined

/** Koffi `void *`, built on first use like every other type in this module. */
function pvoid(): Ptr {
  cachedPvoid ??= koffi().pointer('void')
  return cachedPvoid
}

/** Koffi `void **`, derived from {@link pvoid}. */
function ppvoid(): Ptr {
  cachedPpvoid ??= koffi().pointer(pvoid())
  return cachedPpvoid
}

/** Loaded Win32 libraries and the shared stdcall binder used by process extensions. */
export interface Win32BindingContext {
  /** Kernel process, handle, pipe, and Job APIs. */
  readonly kernel32: ReturnType<Koffi['load']>
  /** Token and security APIs. */
  readonly advapi32: ReturnType<Koffi['load']>
  /** Bind one stdcall function from a loaded Win32 library. */
  readonly bind: (
    library: ReturnType<Koffi['load']>,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ) => unknown
}

/**
 * Return whether a Koffi pointer represents NULL.
 * @param value - pointer value returned by Koffi or a Win32 call.
 * @returns true for null, undefined, or address zero.
 */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

/** STARTUPINFOW fields used by inherited or piped stdio launches. */
export interface StartupInfoInput {
  cb: number
  dwFlags: number
  hStdInput: NativePtr
  hStdOutput: NativePtr
  hStdError: NativePtr
}

/** Decoded PROCESS_INFORMATION result. */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null
  hThread: NativePtr | null
  dwProcessId: number
  dwThreadId: number
}

/** Generic Win32 calls consumed by restricted-token sandbox process operations. */
export interface Win32ProcessBindings {
  closeHandle(handle: NativePtr): number
  getLastError(): number
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null,
  ): number
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number
  createProcessW(
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: Buffer | null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number
  peekNamedPipe(
    pipe: NativePtr,
    buffer: null,
    size: number,
    bytesRead: NativePtr | null,
    totalAvail: NativePtr,
    leftThisMessage: NativePtr | null,
  ): number
  waitForSingleObject(handle: NativePtr, milliseconds: number): number
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number
  createJobObjectW(attributes: null, name: null): NativePtr
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number
  queryInformationJobObject(
    job: NativePtr,
    cls: number,
    information: Buffer,
    length: number,
    returnLength: null,
  ): number
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number
  resumeThread(thread: NativePtr): number
  terminateProcess(process: NativePtr, exitCode: number): number
  terminateJobObject(job: NativePtr, exitCode: number): number
  getStdHandle(stdHandle: number): NativePtr
}

/** Generic Win32 calls plus Node's libuv descriptor-to-handle bridge. */
export interface CurrentTokenProcessBindings extends Win32ProcessBindings {
  uvGetOsfhandle(fileDescriptor: number): NativePtr | null
}

let cachedStructs: { STARTUPINFOW: StructType; PROCESS_INFORMATION: StructType } | undefined

/**
 * Build the Win32 struct types on first use and assert their x64 sizes
 * The ABI guard stays a first-use check instead of a module-scope one, so a
 * platform without a koffi prebuilt binary can import this module and never
 * reach it
 * @returns the cached Koffi struct types.
 */
function structs(): { STARTUPINFOW: StructType; PROCESS_INFORMATION: StructType } {
  if (cachedStructs !== undefined) return cachedStructs
  const ffi = koffi()
  /** Koffi STARTUPINFOW layout. */
  const STARTUPINFOW = ffi.struct('DSH_STARTUPINFOW', {
    cb: 'uint32',
    lpReserved: 'str16',
    lpDesktop: 'str16',
    lpTitle: 'str16',
    dwX: 'uint32',
    dwY: 'uint32',
    dwXSize: 'uint32',
    dwYSize: 'uint32',
    dwXCountChars: 'uint32',
    dwYCountChars: 'uint32',
    dwFillAttribute: 'uint32',
    dwFlags: 'uint32',
    wShowWindow: 'uint16',
    cbReserved2: 'uint16',
    lpReserved2: ffi.pointer('uint8'),
    hStdInput: pvoid(),
    hStdOutput: pvoid(),
    hStdError: pvoid(),
  })
  /** Koffi PROCESS_INFORMATION layout. */
  const PROCESS_INFORMATION = ffi.struct('DSH_PROCESS_INFORMATION', {
    hProcess: pvoid(),
    hThread: pvoid(),
    dwProcessId: 'uint32',
    dwThreadId: 'uint32',
  })
  /* v8 ignore start -- ABI guards are pinned by native header probes. */
  if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
    throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`)
  }
  if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
    throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`)
  }
  /* v8 ignore stop */
  cachedStructs = { STARTUPINFOW, PROCESS_INFORMATION }
  return cachedStructs
}

/**
 * Koffi STARTUPINFOW layout, built and ABI-checked on first use
 * @returns the cached STARTUPINFOW type.
 */
export function startupInfoStruct(): StructType {
  return structs().STARTUPINFOW
}

/**
 * Koffi PROCESS_INFORMATION layout, built and ABI-checked on first use
 * @returns the cached PROCESS_INFORMATION type.
 */
export function processInfoStruct(): StructType {
  return structs().PROCESS_INFORMATION
}

/**
 * Allocate a pointer-sized out-parameter slot.
 * @returns allocated native slot.
 */
export function allocPtrSlot(): NativePtr {
  return koffi().alloc(pvoid(), 1) as NativePtr
}

/**
 * Allocate a uint32 out-parameter slot.
 * @returns allocated native slot.
 */
export function allocUint32(): NativePtr {
  return koffi().alloc('uint32', 1) as NativePtr
}

/**
 * Decode a pointer out-parameter.
 * @param slot - pointer-sized slot filled by Win32.
 * @returns decoded pointer, or null for address zero.
 */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = koffi().decode(slot, pvoid()) as NativePtr | null
  return isNullPtr(value) ? null : value
}

/**
 * Decode a uint32 out-parameter.
 * @param slot - uint32 slot filled by Win32.
 * @returns decoded unsigned value.
 */
export function decodeUint32(slot: NativePtr): number {
  return koffi().decode(slot, 'uint32') as number
}

/**
 * Allocate a zeroed STARTUPINFOW.
 * @returns allocated struct pointer.
 */
export function allocStartupInfo(): NativePtr {
  return koffi().alloc(startupInfoStruct(), 1) as NativePtr
}

/**
 * Encode the stdio-bearing STARTUPINFOW fields.
 * @param startupInfo - allocated STARTUPINFOW pointer.
 * @param fields - fields required for inherited stdio.
 */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi().encode(startupInfo, startupInfoStruct(), fields)
}

/**
 * Allocate a zeroed PROCESS_INFORMATION.
 * @returns allocated struct pointer.
 */
export function allocProcessInfo(): NativePtr {
  return koffi().alloc(processInfoStruct(), 1) as NativePtr
}

/**
 * Decode PROCESS_INFORMATION.
 * @param processInfo - struct pointer filled by CreateProcess.
 * @returns process/thread handles and ids.
 */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return koffi().decode(processInfo, processInfoStruct()) as ProcessInfoOutput
}

let cachedContext: Win32BindingContext | undefined
let cached: CurrentTokenProcessBindings | undefined

/* v8 ignore start -- exercised by native Windows ABI and sandbox jobs. */
function bindingContext(): Win32BindingContext {
  if (cachedContext !== undefined) return cachedContext
  const ffi = koffi()
  const kernel32 = ffi.load('kernel32.dll')
  const advapi32 = ffi.load('advapi32.dll')
  const bind = (
    lib: ReturnType<Koffi['load']>,
    name: string,
    result: Ptr | string,
    args: Array<Ptr | string>,
  ): unknown => lib.func('__stdcall', name, result, args)
  cachedContext = { kernel32, advapi32, bind }
  return cachedContext
}

function bindings(): CurrentTokenProcessBindings {
  if (cached !== undefined) return cached
  const ffi = koffi()
  const PVOID = pvoid()
  const PPVOID = ppvoid()
  const STARTUPINFOW = startupInfoStruct()
  const PROCESS_INFORMATION = processInfoStruct()
  const { kernel32, advapi32, bind } = bindingContext()
  const node = ffi.load(null)
  cached = {
    closeHandle: bind(kernel32, 'CloseHandle', 'int', [PVOID]),
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []),
    formatMessageW: bind(kernel32, 'FormatMessageW', 'uint32', [
      'uint32', PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID,
    ]),
    createPipe: bind(kernel32, 'CreatePipe', 'int', [PPVOID, PPVOID, PVOID, 'uint32']),
    setHandleInformation: bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32']),
    createProcessAsUserW: bind(advapi32, 'CreateProcessAsUserW', 'int', [
      PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi().pointer(STARTUPINFOW), koffi().pointer(PROCESS_INFORMATION),
    ]),
    createProcessW: bind(kernel32, 'CreateProcessW', 'int', [
      'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16',
      koffi().pointer(STARTUPINFOW), koffi().pointer(PROCESS_INFORMATION),
    ]),
    readFile: bind(kernel32, 'ReadFile', 'int', [PVOID, PVOID, 'uint32', koffi().pointer('uint32'), PVOID]),
    peekNamedPipe: bind(kernel32, 'PeekNamedPipe', 'int', [
      PVOID, PVOID, 'uint32', koffi().pointer('uint32'), koffi().pointer('uint32'), koffi().pointer('uint32'),
    ]),
    waitForSingleObject: bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32']),
    getExitCodeProcess: bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi().pointer('uint32')]),
    createJobObjectW: bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16']),
    setInformationJobObject: bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']),
    queryInformationJobObject: bind(kernel32, 'QueryInformationJobObject', 'int', [
      PVOID, 'int', PVOID, 'uint32', PVOID,
    ]),
    assignProcessToJobObject: bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID]),
    resumeThread: bind(kernel32, 'ResumeThread', 'uint32', [PVOID]),
    terminateProcess: bind(kernel32, 'TerminateProcess', 'int', [PVOID, 'uint32']),
    terminateJobObject: bind(kernel32, 'TerminateJobObject', 'int', [PVOID, 'uint32']),
    getStdHandle: bind(kernel32, 'GetStdHandle', PVOID, ['int']),
    uvGetOsfhandle: node.func('uv_get_osfhandle', PVOID, ['int']),
  } as unknown as CurrentTokenProcessBindings
  return cached
}

/**
 * Extend the shared process table with caller-owned Win32 API families.
 * @param create - binds only the caller-specific operations from the shared libraries.
 * @returns generic process bindings combined with the caller-specific operations.
 */
export function extendWin32ProcessBindings<Extension extends object>(
  create: (context: Win32BindingContext) => Extension,
): CurrentTokenProcessBindings & Extension {
  return { ...bindings(), ...create(bindingContext()) }
}

/**
 * Load the generic process binding table without policy-specific extensions.
 * @returns shared Win32 process, stdio, and Job operations.
 */
export function loadWin32ProcessBindings(): CurrentTokenProcessBindings {
  return bindings()
}
/* v8 ignore stop */

/**
 * Format a Win32 error code through FormatMessageW.
 * @param api - active binding table.
 * @param win32Code - captured GetLastError value.
 * @returns trimmed system message, or an empty string when unavailable.
 */
export function errorText(api: Win32ProcessBindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024)
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null,
  )
  return length === 0 ? '' : buffer.subarray(0, length * 2).toString('utf16le').trim()
}

/**
 * Throw the current GetLastError value.
 * @param api - active binding table.
 * @param name - failing Win32 operation.
 * @param detail - optional operation context.
 * @returns never; always throws Win32Error.
 */
export function throwLastError(api: Win32ProcessBindings, name: string, detail?: string): never {
  const win32Code = api.getLastError()
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}

/**
 * Throw an explicitly captured Win32 error code.
 * @param api - active binding table.
 * @param name - failing Win32 operation.
 * @param win32Code - error captured before cleanup.
 * @param detail - optional operation context.
 * @returns never; always throws Win32Error.
 */
export function throwWin32(
  api: Win32ProcessBindings,
  name: string,
  win32Code: number,
  detail?: string,
): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code))
}
