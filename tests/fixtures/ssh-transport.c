/* Local Git transport fixture. Dispatch only two commands to one test repository.
 * No network connection or authentication occurs in this fixture. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "-G") == 0) {
        puts("hostname fixture.invalid\nuser git\nport 2222");
        return 0;
    }
    int host = 0, batch = 0, strict = 0;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "git@fixture.invalid")) host = 1;
        if (!strcmp(argv[i], "BatchMode=yes")) batch = 1;
        if (!strcmp(argv[i], "StrictHostKeyChecking=yes")) strict = 1;
    }
    if (!host || !batch || !strict || argc < 2) return 2;
    const char *command = argv[argc - 1], *service;
    if (!strcmp(command, "git-upload-pack '/remote.git'")) service = "upload-pack";
    else if (!strcmp(command, "git-receive-pack '/remote.git'")) service = "receive-pack";
    else return 2;
    const char *home = getenv("HOME");
    if (!home) return 2;
    char repo[4096];
    int length = snprintf(repo, sizeof(repo), "%s/../remote.git", home);
    if (length < 0 || (size_t)length >= sizeof(repo)) return 2;
#ifdef _WIN32
    /* spawnlp delegates quoting to the caller on Windows. */
    char quoted[4100];
    snprintf(quoted, sizeof(quoted), "\"%s\"", repo);
    return (int)_spawnlp(_P_WAIT, "git.exe", "git.exe", service, quoted, NULL);
#else
    execlp("git", "git", service, repo, (char *)NULL);
    return 2;
#endif
}
