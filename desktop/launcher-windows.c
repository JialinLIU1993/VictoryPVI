#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <wchar.h>

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR args, int show) {
  wchar_t directory[32768], runtime[32768], command[32768];
  GetModuleFileNameW(NULL, directory, 32768);
  wchar_t *last = wcsrchr(directory, L'\\');
  if (!last) return 1;
  *last = 0;
  swprintf(runtime, 32768, L"%ls\\runtime\\node.exe", directory);
  if (GetFileAttributesW(runtime) == INVALID_FILE_ATTRIBUTES) {
    MessageBoxW(NULL, L"请先完整解压下载包，再双击 VictoryPVI。", L"VictoryPVI", MB_OK | MB_ICONINFORMATION);
    return 1;
  }
  swprintf(command, 32768, L"\"%ls\" \"%ls\\app\\desktop\\server.mjs\" --open", runtime, directory);
  STARTUPINFOW start = { sizeof(start) };
  PROCESS_INFORMATION process = {0};
  if (!CreateProcessW(runtime, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, directory, &start, &process)) {
    MessageBoxW(NULL, L"客户端启动失败，请确认下载包已完整解压。", L"VictoryPVI", MB_OK | MB_ICONERROR);
    return 1;
  }
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD result;
  GetExitCodeProcess(process.hProcess, &result);
  CloseHandle(process.hProcess);
  if (result) MessageBoxW(NULL, L"客户端未能启动。请检查是否已有其他程序占用端口 8787。详细原因保存在 %LOCALAPPDATA%\\VictoryPVI\\startup-error.txt。", L"VictoryPVI", MB_OK | MB_ICONERROR);
  return (int)result;
}
