import com.osrsmcp.OsrsMcpPlugin;
import net.runelite.client.RuneLite;
import net.runelite.client.externalplugins.ExternalPluginManager;

public class RunOsrsMcpPlugin {
  public static void main(String[] args) throws Exception {
    ExternalPluginManager.loadBuiltin(OsrsMcpPlugin.class);
    RuneLite.main(args);
  }
}
