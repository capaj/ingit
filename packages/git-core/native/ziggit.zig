const std = @import("std");

const allocator = std.heap.c_allocator;

const Repo = struct {
    root_path: [:0]u8,
};

const VERSION = "ziggit-ffi 0.1.0";
const MAX_OUTPUT_SIZE = 1024 * 64;

const FILE = opaque {};

extern "c" fn popen(command: [*:0]const u8, mode: [*:0]const u8) ?*FILE;
extern "c" fn pclose(stream: *FILE) c_int;
extern "c" fn fread(ptr: [*]u8, size: usize, count: usize, stream: *FILE) usize;

pub export fn ziggit_repo_open(path: [*:0]const u8) ?*Repo {
    const repo = allocator.create(Repo) catch return null;
    errdefer allocator.destroy(repo);

    repo.root_path = allocator.dupeZ(u8, std.mem.span(path)) catch return null;
    return repo;
}

pub export fn ziggit_repo_close(repo: ?*Repo) void {
    const handle = repo orelse return;
    allocator.free(handle.root_path);
    allocator.destroy(handle);
}

pub export fn ziggit_rev_parse_head(repo: ?*Repo, buffer: [*]u8, buffer_len: usize) i32 {
    return runGitToBuffer(repo, &.{ "rev-parse", "HEAD" }, buffer, buffer_len, .trim_trailing_newline);
}

pub export fn ziggit_rev_parse_head_fast(repo: ?*Repo, buffer: [*]u8, buffer_len: usize) i32 {
    return ziggit_rev_parse_head(repo, buffer, buffer_len);
}

pub export fn ziggit_is_clean(repo: ?*Repo) i32 {
    const handle = repo orelse return -1;
    const result = runGit(handle, &.{ "status", "--porcelain" }) catch return -1;
    defer freeRunResult(result);

    return if (result.stdout.len == 0) 1 else 0;
}

pub export fn ziggit_status_porcelain(repo: ?*Repo, buffer: [*]u8, buffer_len: usize) i32 {
    return runGitToBuffer(repo, &.{ "status", "--porcelain" }, buffer, buffer_len, .keep_output);
}

pub export fn ziggit_checkout(repo: ?*Repo, ref_name: [*:0]const u8) i32 {
    const handle = repo orelse return -1;
    const result = runGit(handle, &.{ "checkout", std.mem.span(ref_name) }) catch return -1;
    defer freeRunResult(result);
    return 0;
}

pub export fn ziggit_fetch(repo: ?*Repo) i32 {
    const handle = repo orelse return -1;
    const result = runGit(handle, &.{"fetch"}) catch return -1;
    defer freeRunResult(result);
    return 0;
}

pub export fn ziggit_remote_get_url(repo: ?*Repo, remote_name: [*:0]const u8, buffer: [*]u8, buffer_len: usize) i32 {
    return runGitToBuffer(repo, &.{ "remote", "get-url", std.mem.span(remote_name) }, buffer, buffer_len, .trim_trailing_newline);
}

pub export fn ziggit_find_commit(repo: ?*Repo, committish: [*:0]const u8, buffer: [*]u8, buffer_len: usize) i32 {
    const rev = std.fmt.allocPrint(allocator, "{s}^{{commit}}", .{std.mem.span(committish)}) catch return -1;
    defer allocator.free(rev);

    return runGitToBuffer(repo, &.{ "rev-parse", "--verify", rev }, buffer, buffer_len, .trim_trailing_newline);
}

pub export fn ziggit_version() [*:0]const u8 {
    return VERSION;
}

const OutputMode = enum {
    keep_output,
    trim_trailing_newline,
};

const RunResult = struct {
    stdout: []u8,
};

fn runGitToBuffer(repo: ?*Repo, args: []const []const u8, buffer: [*]u8, buffer_len: usize, mode: OutputMode) i32 {
    const handle = repo orelse return -1;
    const result = runGit(handle, args) catch return -1;
    defer freeRunResult(result);

    const output = switch (mode) {
        .keep_output => result.stdout,
        .trim_trailing_newline => trimTrailingNewline(result.stdout),
    };

    return copyToBuffer(buffer, buffer_len, output);
}

fn runGit(repo: *Repo, args: []const []const u8) !RunResult {
    const command = try buildGitCommand(repo.root_path, args);
    defer allocator.free(command);

    const stream = popen(command.ptr, "r") orelse return error.GitSpawnFailed;
    errdefer _ = pclose(stream);

    const output = try allocator.alloc(u8, MAX_OUTPUT_SIZE);
    errdefer allocator.free(output);

    var total: usize = 0;
    while (total < output.len) {
        const read_count = fread(output.ptr + total, 1, output.len - total, stream);
        if (read_count == 0) break;
        total += read_count;
    }

    const status = pclose(stream);
    if (status != 0) return error.GitExitedNonZero;
    if (total == output.len) return error.OutputTooLong;

    return .{ .stdout = output[0..total] };
}

fn freeRunResult(result: RunResult) void {
    allocator.free(result.stdout);
}

fn copyToBuffer(buffer: [*]u8, buffer_len: usize, output: []const u8) i32 {
    if (buffer_len == 0 or output.len >= buffer_len) return -2;

    @memcpy(buffer[0..output.len], output);
    buffer[output.len] = 0;
    return 0;
}

fn trimTrailingNewline(output: []const u8) []const u8 {
    var end = output.len;
    while (end > 0 and (output[end - 1] == '\n' or output[end - 1] == '\r')) {
        end -= 1;
    }
    return output[0..end];
}

fn buildGitCommand(root_path: []const u8, args: []const []const u8) ![:0]u8 {
    var command_len: usize = "git -C ".len + quotedLen(root_path) + " 2>/dev/null".len;
    for (args) |arg| {
        command_len += 1 + quotedLen(arg);
    }

    const command = try allocator.allocSentinel(u8, command_len, 0);
    var index: usize = 0;

    appendLiteral(command, &index, "git -C ");
    appendQuoted(command, &index, root_path);
    for (args) |arg| {
        appendLiteral(command, &index, " ");
        appendQuoted(command, &index, arg);
    }
    appendLiteral(command, &index, " 2>/dev/null");

    return command;
}

fn quotedLen(value: []const u8) usize {
    var len: usize = 2;
    for (value) |byte| {
        len += if (byte == '\'') 4 else 1;
    }
    return len;
}

fn appendQuoted(buffer: []u8, index: *usize, value: []const u8) void {
    buffer[index.*] = '\'';
    index.* += 1;

    for (value) |byte| {
        if (byte == '\'') {
            appendLiteral(buffer, index, "'\\''");
        } else {
            buffer[index.*] = byte;
            index.* += 1;
        }
    }

    buffer[index.*] = '\'';
    index.* += 1;
}

fn appendLiteral(buffer: []u8, index: *usize, literal: []const u8) void {
    @memcpy(buffer[index.* .. index.* + literal.len], literal);
    index.* += literal.len;
}
