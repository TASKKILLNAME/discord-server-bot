using System;
using System.Diagnostics;
using System.IO;

internal static class BackgroundBotLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 2) return 2;
        string projectDirectory = Path.GetFullPath(args[1]);
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = args[0],
                Arguments = "\"" + Path.Combine(projectDirectory, "scripts", "local-runner.js") + "\" --local-task",
                WorkingDirectory = projectDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            // Keep the task alive and propagate Node's exit code for scheduler retries.
            using (var bot = Process.Start(start))
            {
                bot.WaitForExit();
                return bot.ExitCode;
            }
        }
        catch (Exception error)
        {
            try
            {
                string logs = Path.Combine(projectDirectory, "logs");
                Directory.CreateDirectory(logs);
                File.AppendAllText(Path.Combine(logs, "bot-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log"),
                    "[" + DateTime.UtcNow.ToString("o") + "] [fatal] Background launcher: " + error + Environment.NewLine);
            }
            catch { }
            return 1;
        }
    }
}
