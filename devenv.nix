# devenv.nix
{ pkgs, ... }:

{
  cachix.enable = false;

  languages = {
    javascript = {
      enable = true;
      package = pkgs.nodejs_20;
      npm.enable = true;
    };
    typescript.enable = true;
  };

  packages = with pkgs; [
    git
    nodejs
    ffmpeg  # For audio processing
  ];

  # Enable dotenv integration for loading .env files
  dotenv.enable = true;

  services.postgres = {
    enable = true;
    listen_addresses = "*";
    initialDatabases = [
      {
        name = "tapstory";
        user = "tapstory_user";
        pass = "tapstory_password";
      }
      {
        name = "tapstory_shadow";
        user = "tapstory_user";
        pass = "tapstory_password";
      }
      {
        name = "tapstory_test";
        user = "tapstory_user";
        pass = "tapstory_password";
      }
    ];
    initialScript = ''
      ALTER USER tapstory_user LOGIN CREATEDB;
    '';
  };

  # Test database URL (production and dev URLs are in backend/.env)
  env.DATABASE_URL_TEST = "postgresql://tapstory_user:tapstory_password@localhost:5432/tapstory_test";

  scripts.setup.exec = ''
    echo "📦 Installing deps and generating Prisma client..."
    npm install
    npm run prisma -- generate
    npm run migrate
  '';

  enterShell = ''
    echo "🎙️  Welcome to Tap Story. Postgres is running. Use the aliases below:"
    echo ""
    echo "  ▶️  Run services manually:"
    echo "     $ npm run dev:api     # backend"
    echo "     $ npm run dev:mobile  # mobile app"
    echo ""
    echo "  📊 Database operations:"
    echo "     $ npm run db:query    # open Prisma Studio"
    echo "     $ npm run migrate     # run migrations"
    echo "     $ npm run seed        # seed database"
    echo ""
    echo "  🧪 Testing:"
    echo "     $ npm test            # run all tests"
    echo "     $ npm run check       # TypeScript type checking"
    echo ""
  '';

  }
